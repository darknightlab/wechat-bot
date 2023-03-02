import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import * as crypto from "crypto";
import YAML from "yaml";
import urlRegexSafe from "url-regex-safe";
import qrcodeTerminal from "qrcode-terminal";
import schedule from "node-schedule";
import * as URI from "uri-js";
import nodemailer from "nodemailer";
import { Contact, Message, ScanStatus, WechatyBuilder, log, Friendship } from "wechaty";
import { XMLParser, XMLBuilder, XMLValidator } from "fast-xml-parser";
import { decode } from "html-entities";
import { execSync, spawn } from "node:child_process";
import { ChatGPTAPI, ChatMessage, SendMessageOptions } from "chatgpt";

// 实现的不好看
// 为了在外部控制promise的resolve和reject, 详见 https://stackoverflow.com/questions/26150232/resolve-javascript-promise-outside-the-promise-constructor-scope
class Task<T> {
    private _resolve: (value: T) => void = () => {};
    private _reject: (reason?: any) => void = () => {};
    private _promise: Promise<T>;

    constructor(executor: (resolve: (value: T) => void, reject: (reason?: any) => void) => void) {
        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
            executor(resolve, reject);
        });
    }

    result() {
        return this._promise;
    }

    resolve(value: T) {
        this._resolve(value);
    }

    reject(reason?: any) {
        this._reject(reason);
    }
}

const parser = new XMLParser();

const configPath = "./config/config.yaml";
const config = YAML.parse(fs.readFileSync(configPath, "utf8"));

// Wechat

const APPNAME = "wechat-bot";
const Command = new Map<string, Function>([
    ["chatgpt", cmd_chatgpt],
    ["auth", cmd_auth],
    ["archive", cmd_archive],
    ["animepic", cmd_animepic],
    ["test", cmd_test],
]);

type WechatConversationOption = {
    chatgpt: {
        enable: boolean;
        conversationId: string | undefined;
        replyEveryoneInRoom: boolean;
        customRoleToContact: boolean;
    };
    archivebox: {
        enable: boolean;
    };
    animepic: {
        enable: boolean;
    };
};

type WechatConversation = {
    id: string;
    name: string;
    type: string; // contact or room
    option: WechatConversationOption;
};

let ReadyTime: Date;
let MyWeChat: Contact | undefined;
let AuthedID: Set<string> = new Set();
let Jobs: Map<string, schedule.Job> = new Map();
let MsgQueue: Map<string, Task<Message>[]> = new Map();
let WechatConversations = new Map<string, WechatConversation>();
let OldWechatConversations = new Map<string, WechatConversation>(); // string是上一次的id, 仅用作恢复chatgpt时的查找
// let WechatConversationOptions: Map<string, WechatConversationOption> = new Map();
let DefaultWechatConversationOption: WechatConversationOption = {
    chatgpt: {
        enable: config.chatgpt.enable,
        conversationId: undefined,
        replyEveryoneInRoom: false,
        customRoleToContact: false,
    },
    archivebox: {
        enable: config.archive.enable,
    },
    animepic: {
        enable: config.animepic.enable,
    },
};

async function middleware(msg: Message) {
    return msg;
}

function isAuthed(id: string) {
    return AuthedID.has(id);
}

function dumpWeChatConversation() {
    fs.writeFileSync(`config/${APPNAME}.conversation.wechat.json`, JSON.stringify([...WechatConversations.values()]));
}

async function loadWeChatConversation() {
    // 需要在ready后调用
    try {
        let clist: WechatConversation[] = JSON.parse(fs.readFileSync(`config/${APPNAME}.conversation.wechat.json`, "utf8"));
        for (let c of clist) {
            // 有可能导致OldWechatConversations恢复的数量是全的, 而WechatConversations恢复的数量相对少了那些多个同名的或者不存在的
            OldWechatConversations.set(c.id, c); // 这里的value和下面的value是相同的指针, 因此value的id会被修改
            if (c.type == "contact") {
                let contacts = await bot.Contact.findAll({ name: c.name });
                if (contacts.length == 1) {
                    c.id = contacts[0].id;
                    WechatConversations.set(c.id, c);
                } else {
                    let ok = false;
                    contacts.forEach((contact) => {
                        if (contact.id == c.id) {
                            // padlocal, id不变, 保存时的id和现在的contact id一致
                            WechatConversations.set(c.id, c);
                            ok = true;
                        }
                    });
                    if (!ok) {
                        // 有多个名字相同的联系人, 但是id不同
                        // 无法确定是哪个联系人, 不保存
                        OldWechatConversations.delete(c.id);
                        log.warn("loadWeChatConversation", `无法找到或有多个同名联系人${c.name}, 会话无法恢复`);
                    }
                }
            } else if (c.type == "room") {
                let rooms = await bot.Room.findAll({ topic: c.name });
                if (rooms.length == 1) {
                    c.id = rooms[0].id;
                    WechatConversations.set(c.id, c);
                } else {
                    let ok = false;
                    rooms.forEach((room) => {
                        if (room.id == c.id) {
                            // padlocal, id不变, 保存时的id和现在的room id一致
                            WechatConversations.set(c.id, c);
                            ok = true;
                        }
                    });
                    if (!ok) {
                        // 有多个名字相同的群, 但是id不同
                        // 无法确定是哪个群, 不保存
                        OldWechatConversations.delete(c.id);
                        log.warn("loadWeChatConversation", `无法找到或有多个同名群${c.name}, 会话无法恢复`);
                    }
                }
            }
        }
    } catch (e: any) {
        log.warn("loadWeChatConversation", e.message);
    }
}

async function getWechatConversation(msg: Message) {
    let id = msg.room() ? msg.room()!.id : msg.talker().id;
    if (!WechatConversations.has(id)) {
        let name = msg.room() ? await msg.room()!.topic() : msg.talker().name();
        let type = msg.room() ? "room" : "contact";
        let conversation: WechatConversation = {
            id: id,
            name: name,
            type: type,
            option: JSON.parse(JSON.stringify(DefaultWechatConversationOption)),
        };
        WechatConversations.set(id, conversation);
        dumpWeChatConversation();
    }
    return WechatConversations.get(id)!;
}

function msgFromFriend(msg: Message) {
    // let notFriend = ["微信安全中心", "文件传输助手", "朋友推荐消息", "微信支付", "服务通知", "微信团队"];
    return !msg.self() && !msg.room() && msg.talker().type() == bot.Contact.Type.Individual && msg.talker().friend(); // && !notFriend.includes(msg.talker().name())
}

function msgFromRoom(msg: Message) {
    return !msg.self() && msg.room();
}

function nextMessage(one: WechatConversation) {
    // 如果不存在该联系人的队列, 用id创建一个.
    if (!MsgQueue.has(one.id)) {
        MsgQueue.set(one.id, []);
    }
    let msgList = MsgQueue.get(one.id)!;
    let task = new Task((resolve: (msg: Message) => void) => {});
    msgList.push(task);
    return task;
}

// 检测文本是否包含命令
async function cmdInText(msg: Message) {
    let text = await msg.mentionText();
    let textList = text.split(" ");
    if (textList[0].startsWith("/")) {
        let cmd = textList[0].slice(1);
        if (Command.has(cmd)) {
            try {
                await Command.get(cmd)!(textList.slice(1), msg);
            } catch (e: any) {
                await msg.say(e.message);
            }
        } else {
            await msg.say(`未知命令: /${cmd}`);
        }
        return true;
    }
    return false;
}

async function cmd_auth(args: string[], msg: Message) {
    // 认证用个人, 群组不行
    if (AuthedID.has(msg.talker().id)) {
        await msg.say("已认证");
    } else {
        if (args.length === 1 && args[0] === config.wechat.authPassword) {
            AuthedID.add(msg.talker().id);
            await msg.say("认证成功");
        } else {
            await msg.say("认证失败");
        }
    }
}

async function cmd_chatgpt(args: string[], msg: Message) {
    let wechatConversation = await getWechatConversation(msg);
    async function clear() {
        let chatGPTConversation = newChatGPTConversation(chatGPT, wechatConversation);
        ChatGPTSession.set(wechatConversation.id, chatGPTConversation);
        wechatConversation.option.chatgpt.conversationId = chatGPTConversation.conversationId;
        dumpChatGPTSession();
        await msg.say("已清空聊天记录");
    }
    if (args.length > 0) {
        switch (args[0]) {
            case "clear":
                await clear();
                break;

            case "recover": // 恢复chatgpt会话
                if (args.length == 2) {
                    let name = args[1];
                    let tmpl = conversationTmpls.tmpl.get(name);
                    if (!tmpl) {
                        await msg.say(`未找到会话模板: ${name}`);
                        break;
                    }
                    if (!ChatGPTSession.has(wechatConversation.id)) {
                        log.info("cmd_chatgpt", "Create new ChatGPT conversation");
                        let chatGPTConversation = newChatGPTConversation(chatGPT, wechatConversation);
                        ChatGPTSession.set(wechatConversation.id, chatGPTConversation);
                        wechatConversation.option.chatgpt.conversationId = chatGPTConversation.conversationId;
                    }
                    let session = ChatGPTSession.get(wechatConversation.id)!;
                    session.conversationId = tmpl.convesationId;
                    session.messageIdList = [...tmpl.messageIdList];
                    dumpChatGPTSession();
                    await msg.say("恢复成功");
                }
                break;

            case "save": // 储存chatgpt会话
                if (args.length == 2) {
                    let name = args[1];
                    let session = ChatGPTSession.get(wechatConversation.id);
                    if (!session || !session.conversationId) {
                        await msg.say("还未进行有效的对话");
                        break;
                    }
                    let tmpl: {
                        convesationId: string;
                        messageIdList: string[];
                    } = {
                        convesationId: session.conversationId,
                        messageIdList: [...session.messageIdList],
                    };
                    conversationTmpls.tmpl.set(name, tmpl);
                    session!.messageIdList.forEach((messageId) => {
                        let chatMessage = MessageMap.get(messageId)!;
                        conversationTmpls.messageMap.set(chatMessage.parentMessageId!, MessageMap.get(chatMessage.parentMessageId!)!);
                        conversationTmpls.messageMap.set(messageId, chatMessage);
                    });
                    dumpConversationTmpl();
                    await msg.say("已保存");
                }
                break;

            case "tmpl":
                if (args.length >= 2) {
                    // 列出模板
                    switch (args[1]) {
                        case "list":
                            let res = "";
                            conversationTmpls.tmpl.forEach((tmpl, name) => {
                                res += name + " ";
                            });
                            res = res.trim();
                            await msg.say(res);
                            break;
                        case "delete":
                            if (args.length == 3) {
                                let name = args[2];
                                conversationTmpls.tmpl.get(name)?.messageIdList.forEach((messageId) => {
                                    conversationTmpls.messageMap.delete(messageId);
                                });
                                conversationTmpls.tmpl.delete(name);
                                dumpConversationTmpl();
                                await msg.say("已删除");
                            }
                            break;
                    }
                }
                break;

            case "disable":
                if (args.length == 1) {
                    wechatConversation.option.chatgpt.enable = false;
                    if (ChatGPTSession.has(wechatConversation.id)) {
                        ChatGPTSession.delete(wechatConversation.id);
                        dumpChatGPTSession();
                    }
                } else if (args.length == 2) {
                    if (args[1] == "replyEveryoneInRoom") {
                        wechatConversation.option.chatgpt.replyEveryoneInRoom = false;
                        await msg.say("已关闭在群里回复所有人");
                    } else if (args[1] == "customRoleToContact") {
                        wechatConversation.option.chatgpt.customRoleToContact = false;
                        await clear();
                        await msg.say("已关闭自定义角色");
                    }
                }
                dumpWeChatConversation();
                break;

            case "enable":
                if (args.length == 1) {
                    // 已经确定wechatConversationOptions存在id
                    wechatConversation.option.chatgpt.enable = true;
                } else if (args.length == 2) {
                    if (args[1] == "replyEveryoneInRoom") {
                        wechatConversation.option.chatgpt.replyEveryoneInRoom = true;
                        await msg.say("已开启在群里回复所有人");
                    } else if (args[1] == "customRoleToContact") {
                        wechatConversation.option.chatgpt.customRoleToContact = true;
                        await clear();
                        await msg.say("已开启自定义角色");
                    }
                }
                dumpWeChatConversation();
                break;

            default:
                // 命令错误
                await msg.say("/chatgpt [clear|recover|save|enable|disable]");
                break;
        }
    } else {
        await msg.say("/chatgpt [clear|recover|save|enable|disable]");
    }
}

async function cmd_archive(args: string[], msg: Message) {
    let wechatConversation = await getWechatConversation(msg);
    if (args.length > 0) {
        switch (args[0]) {
            case "enable":
                wechatConversation.option.archivebox.enable = true;
                dumpWeChatConversation();
                break;
            case "disable":
                wechatConversation.option.archivebox.enable = false;
                dumpWeChatConversation();
                break;
            default:
                await msg.say("/archive [enable|disable]");
                break;
        }
    }
}

async function cmd_animepic(args: string[], msg: Message) {
    let wechatConversation = await getWechatConversation(msg);
    if (args.length > 0) {
        switch (args[0]) {
            case "enable":
                wechatConversation.option.animepic.enable = true;
                dumpWeChatConversation();
                break;
            case "disable":
                wechatConversation.option.animepic.enable = false;
                dumpWeChatConversation();
                break;
            default:
                await msg.say("/animepic [enable|disable]");
                break;
        }
    }
}

async function cmd_test(args: string[], msg: Message) {
    let wechatConversation = await getWechatConversation(msg);
    await msg.say("请在下一条消息中发送任意内容");
    let nextMsg = await nextMessage(wechatConversation).result();
    await msg.say(nextMsg.text());
}

// Mailer

// qrcodeAPIURL 已被config.wechat.qrcodeAPI替代
// const qrcodeAPIURL = "https://api.qrserver.com/v1/create-qr-code/?data="; // "https://wechaty.js.org/qrcode/" wechaty 自带接口
const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port == 465,
    auth: {
        user: config.email.username,
        pass: config.email.password,
    },
});

let LastMailTime = (() => {
    let now = new Date();
    now.setTime(now.getTime() - config.email.interval * 1000);
    return now;
})();

// Archivebox

let TodayPostsSaved: Set<string> = new Set();

async function send2Archive(url: string) {
    let resultStr = execSync(config.archive.command, {
        env: {
            URL: url,
            ARCHIVE_DISPLAY_MODE: config.archive.displayMode,
            ARCHIVE_URL: config.archive.url, // 归档网站的url
            ARCHIVE_LOCAL_URL: config.archive.localurl,
            ARCHIVE_USERNAME: config.archive.username,
            ARCHIVE_PASSWORD: config.archive.password,
        },
    }).toString("utf8");
    let result = JSON.parse(resultStr);
    if (result.hasOwnProperty("status") && result.status === "success") {
        TodayPostsSaved.add(result.url);
        return result.url as string;
    } else {
        return null;
    }
}

// ChatGPT

type ConversationTmpls = {
    tmpl: Map<
        string,
        {
            convesationId: string;
            messageIdList: string[];
        }
    >;
    messageMap: Map<string, ChatMessage>;
};

let chatGPT: ChatGPTAPI[] = [];
config.chatgpt.apiKeys.forEach((apiKey: string) => {
    chatGPT.push(
        new ChatGPTAPI({
            apiKey: apiKey,
            getMessageById: getMessageById,
            upsertMessage: upsertMessage,
            maxModelTokens: config.chatgpt.model.maxModelTokens || 4096,
            completionParams: {
                model: config.chatgpt.model.name || "gpt-3.5-turbo-0301",
            },
        })
    );
});

let ChatGPTSession: Map<string, ChatGPTConversation> = new Map(); // string是WechatConversation的id, 会话可以随时重置, 但是wechat id在单次登录时永远不变
let MessageMap: Map<string, ChatMessage> = new Map();
let conversationTmpls: ConversationTmpls = {
    tmpl: new Map(),
    messageMap: new Map(),
};

class ChatGPTConversation {
    wechatConversation: WechatConversation;
    conversationId: string;
    messageIdList: string[];
    systemMessage: string | undefined;

    _apiPool: ChatGPTAPI[];
    constructor(apiPool: ChatGPTAPI[], wechatC: WechatConversation) {
        this._apiPool = apiPool;
        this.conversationId = crypto.randomUUID();
        this.wechatConversation = wechatC;
        wechatC.option.chatgpt.conversationId = this.conversationId;
        this.messageIdList = [];
    }

    async sendMessage(message: string, opts: SendMessageOptions = {}, roomOptions: { name?: string; time?: string; mentionSelf?: boolean } = {}) {
        opts.systemMessage = opts.systemMessage || this.systemMessage;
        opts.name = roomOptions.name || opts.name;

        // 这里的逻辑是, 当群聊中有两个人在很接近的时间之内连发两条消息, 则他们都以这之前的最后一条ai消息作为上文.
        if (this.messageIdList.length > 0 && !opts.parentMessageId) {
            opts.parentMessageId = this.messageIdList[this.messageIdList.length - 1];
        }

        let newMessage: string = "";
        switch (this.wechatConversation.type) {
            case "contact":
                newMessage = message;
                break;
            case "room":
                newMessage = JSON.stringify({ name: roomOptions.name, mentionSelf: roomOptions.mentionSelf, time: roomOptions.time, text: message }); // name: roomOptions.name,
                break;
        }
        let response = await this._apiPool[Math.floor(Math.random() * this._apiPool.length)].sendMessage(newMessage, opts);
        this.messageIdList.push(response.id);
        dumpChatGPTSession();

        let respText: string | undefined;
        switch (this.wechatConversation.type) {
            case "contact":
                respText = response.text;
                break;
            case "room":
                let logPrefix = "ChatGPTInRoom";
                let respJSON: { send: boolean | string; text: string };
                try {
                    respJSON = JSON.parse(response.text);
                    if (respJSON.send) {
                        respText = respJSON.text;
                    } else {
                        log.info(logPrefix, "send==false, ChatGPT希望不作回复");
                    }
                } catch (e) {
                    respText = response.text;
                    log.warn(logPrefix, "ChatGPT返回的消息不是json，已经自动转换为json");
                }
                break;
        }
        return respText;
    }
}

async function getMessageById(id: string) {
    return MessageMap.get(id)!;
}

async function upsertMessage(message: ChatMessage) {
    MessageMap.set(message.id, message);
    // dump
    fs.writeFileSync(`config/${APPNAME}.message.chatgpt.json`, JSON.stringify(Object.fromEntries(MessageMap)));
}

function dumpConversationTmpl() {
    let t = {
        tmpl: Object.fromEntries(conversationTmpls.tmpl),
        messageMap: Object.fromEntries(conversationTmpls.messageMap),
    };
    fs.writeFileSync(`config/${APPNAME}.template.chatgpt.json`, JSON.stringify(t));
}

// 储存ChatGPTSession到文本
function dumpChatGPTSession() {
    // session
    // chatgptsession是id到对话的映射, 而存储到json后是包含id和名字的数组. chatgptconversation当中还含有联系人的名字. 恢复时利用名字恢复.
    type Conversation = {
        wechatConversationId: string;
        conversationId: string | undefined;
        messageIdList: string[];
    };

    let session: Conversation[] = [];
    ChatGPTSession.forEach((v) => {
        session.push({
            wechatConversationId: v.wechatConversation.id,
            conversationId: v.conversationId,
            messageIdList: v.messageIdList,
        });
    });
    let str = JSON.stringify({
        account: bot.currentUser.name(),
        session: session,
    });
    fs.writeFileSync(`config/${APPNAME}.session.chatgpt.json`, str);
}

// 恢复所有有关ChatGPT的数据
async function loadChatGPT(api: ChatGPTAPI[] = chatGPT) {
    // 此时所有的待恢复的东西一定是空的
    // session
    type Conversation = {
        wechatConversationId: string;
        conversationId: string;
        messageIdList: string[];
    };

    try {
        let str = fs.readFileSync(`config/${APPNAME}.session.chatgpt.json`, "utf8");
        let obj = JSON.parse(str);
        if (obj.account == bot.currentUser.name()) {
            let session: Conversation[] = obj.session;
            session.forEach(async (v) => {
                let wechatConversation = OldWechatConversations.get(v.wechatConversationId);
                if (!wechatConversation) {
                    // 说明这个会话已经不存在了, 不恢复ChatGPT的内容
                    return;
                }
                let c = newChatGPTConversation(api, wechatConversation);
                c.conversationId = v.conversationId;
                c.messageIdList = v.messageIdList;
                ChatGPTSession.set(wechatConversation.id, c);
                wechatConversation.option.chatgpt.conversationId = c.conversationId;
            });
        }
    } catch (e: any) {
        log.warn("ChatGPT", e.message);
    }
    // message
    try {
        let str = fs.readFileSync(`config/${APPNAME}.message.chatgpt.json`, "utf8");
        let obj = JSON.parse(str);
        MessageMap = new Map<string, ChatMessage>(Object.entries(obj));
    } catch (e: any) {
        log.warn("ChatGPT", e.message);
    }
    // template
    try {
        let str = fs.readFileSync(`config/${APPNAME}.template.chatgpt.json`, "utf8");
        let obj: { tmpl: any; messageMap: any } = JSON.parse(str);
        conversationTmpls.tmpl = new Map<
            string,
            {
                convesationId: string;
                messageIdList: string[];
            }
        >(Object.entries(obj.tmpl));
        conversationTmpls.messageMap = new Map<string, ChatMessage>(Object.entries(obj.messageMap));
        conversationTmpls.messageMap.forEach((chatMessage, messageId) => {
            MessageMap.set(messageId, chatMessage);
        });
    } catch (e: any) {
        log.warn("ChatGPT", e.message);
    }
}

function newChatGPTConversation(api: ChatGPTAPI[], wechatConversation: WechatConversation) {
    let c = new ChatGPTConversation(api, wechatConversation);
    switch (wechatConversation.type) {
        case "contact":
            if (wechatConversation.option.chatgpt.customRoleToContact) {
                if (config.chatgpt.contactRole) {
                    c.systemMessage = `${config.chatgpt.contactRole}
                    当前时间: ${new Date().toString()}`;
                } else {
                    log.warn("ChatGPT", "未设置contactRole但启用了自定义角色, 无法使用自定义角色, 恢复默认");
                }
            }
            break;
        case "room":
            c.systemMessage = `
            你处在一个微信群中，需要和很多人聊天。你的微信用户名是${bot.currentUser.name()}
            聊天的信息以json格式传递给你，其中包含了发送人姓名，发送时间，是否提及你，以及内容。格式类似如下：
            '{"name":xxx, "mentionSelf": false, "time": "xxx", "text": "消息内容"}'。
            你需要回复一个json，其中包含了是否发送消息，以及发送的内容。格式必须如下：
            '{"send": true, "text": "你发送的消息"}'。
            如果消息提及了你，即mentionSelf==true，你必须回复消息。如果消息没有提及你并且你认为这条消息不是发给你的，你就不能回复。不回复的格式必须如下：
            '{"send": false}'。
            利用'@'可以强调这句话是回复某人的，如：@某人 。
            ${config.chatgpt.roomRole ? config.chatgpt.roomRole : "你是 ChatGPT，OpenAI 训练的大型语言模型。你对每个回复都尽可能简洁地回答。尽可能简洁地回答是非常重要的，所以请记住这一点。如果要生成列表，则不要有太多项目。保持项目数量简短。"}
            在消息没有提及你的情况下，你需要控制回复频率，你最多只能连续回复50%的消息，平均回复率大约为10%。
            `;
            // c.promptPrefix = `
            // You are in a WeChat group and need to chat with many people. Your WeChat account name is ${bot.currentUser.name()}
            // The chat information is passed to you in json format, which includes the sender's name, sending time, whether you are mentioned, and the content. The format is similar to the following:
            // '{"name": "xxx", time: "xxx", "mentionSelf": false, "text": "message content"}'.
            // You need to reply with a json, which includes whether to send a message, and what to send. The format must be as follows:
            // '{"send": true, "text": "The message you sent"}'.
            // If the message mentions you, i.e. mentionSelf==true, you must reply to the message. If a message doesn't mention you and you don't think it was meant for you, you can't reply. The format of the non-reply must be as follows:
            // '{"send": false}'.
            // If you want to remind someone specifically, you can use @hisname followed by a space to mention him in the message, such as: @xx How are you?.
            // ${
            //     config.chatgpt.roomRole
            //         ? config.chatgpt.roomRole
            //         : "你是 ChatGPT，OpenAI 训练的大型语言模型。你对每个回复都尽可能简洁地回答（例如，不要冗长）。尽可能简洁地回答是非常重要的，所以请记住这一点。如果要生成列表，则不要有太多项目。保持项目数量简短。"
            // }
            // In the case that the message does not mention you, you need to control the reply frequency. You can only reply to 50% of the messages continuously at most, and the average reply rate is about 10%.
            // `;
            break;
    }
    return c;
}

// Wechaty 事件

async function onScan(qrcode: string, status: ScanStatus) {
    if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
        const qrcodeImageUrl = [config.wechat.qrcodeAPI, encodeURIComponent(qrcode)].join("");
        log.info("StarterBot", "onScan: %s(%s) - %s", ScanStatus[status], status, qrcodeImageUrl);

        // 如果到达允许的邮件间隔时间, 发送二维码邮件
        try {
            if (new Date().getTime() - LastMailTime.getTime() > config.email.interval * 1000) {
                await transporter.sendMail({
                    from: `"${config.email.senderName}" <${config.email.sender}>`,
                    to: config.email.receiver,
                    subject: "wechat-bot: 请扫码登录",
                    text: "请扫码登录",
                    html: `<img src="${qrcodeImageUrl}">`,
                });
                LastMailTime = new Date();
                log.info("StarterBot", "onScan: Send mail successfully");
            }
        } catch (e) {
            log.error("SendMail", e);
        }

        qrcodeTerminal.generate(qrcode, { small: true }); // show qrcode on console
    } else {
        log.info("StarterBot", "onScan: %s(%s)", ScanStatus[status], status);
    }
}

async function onLogin(user: Contact) {
    log.info("StarterBot", "%s login", user);
}

async function onReady() {
    ReadyTime = new Date();
    log.info("StarterBot", "bot is ready");
    await loadWeChatConversation();
    await loadChatGPT(chatGPT);
    MyWeChat = await bot.Contact.find(config.wechat.myaccount);
    if (!MyWeChat) {
        throw new Error(`Account ${config.wechat.myaccount} not found`);
    }

    // 已确认MyWeChat不为undefined
    let report = schedule.scheduleJob(
        {
            rule: config.wechat.reportTime.cron,
            tz: config.wechat.reportTime.timezone,
        },
        async () => {
            await MyWeChat!.say(`统计时间内已存档${TodayPostsSaved.size}个网页`);
            TodayPostsSaved.clear();
        }
    );
    // Jobs.get("report")
    Jobs.set("report", report);
    log.info("StarterBot", `report job scheduled, will send it to ${MyWeChat.name()}`);
}

function onLogout(user: Contact) {
    log.info("StarterBot", "%s logout", user);
}

async function onMessage(msg: Message) {
    let logPrefix = "Message";
    log.info(logPrefix, msg.toString());

    if (msg.self()) {
        return;
    }

    // 只回复ReadyTime之后的消息
    if (!ReadyTime || msg.date() < ReadyTime) {
        log.info(logPrefix, "Message Date=%s, ReadyTime=%s, skip", msg.date(), ReadyTime);
        return;
    }

    let wechatConversation = await getWechatConversation(msg); // 实际上是Contact|Room

    let inRoom = wechatConversation.type == "room";
    let normalMessage = msgFromFriend(msg) || (inRoom && (await msg.mentionSelf()));
    let replyEveryoneInRoom = wechatConversation.option.chatgpt.replyEveryoneInRoom;

    if (inRoom) {
        wechatConversation.name = await msg.room()!.topic();
    }

    if (normalMessage) {
        // 只有好友或者在群里面at自己的消息才能触发一般操作
        // let msgText = await msg.mentionText();
        let msgText = msg.text();

        // 优先级高于命令!! 例如在等待消息的过程中, 尽管接收到的是disable的命令, 也会因为这里的return而跳过.
        // 如果有等待消息的队列, 则捕捉消息
        if (MsgQueue.has(wechatConversation.id)) {
            let queue = MsgQueue.get(wechatConversation.id)!;
            if (queue.length > 0) {
                let p = queue.shift()!;
                p.resolve(msg);
                return;
            }
        }

        // let wechatConversationOption: WechatConversationOption;
        // if (WechatConversationOptions.has(wechatConversation.id)) {
        //     wechatConversationOption = WechatConversationOptions.get(wechatConversation.id)!;
        // } else {
        //     wechatConversationOption = DefaultWechatConversationOption;
        //     WechatConversationOptions.set(wechatConversation.id, wechatConversationOption);
        // }

        switch (msg.type()) {
            // 消息属于类似公众号的美观链接
            case bot.Message.Type.Attachment:
                log.info(logPrefix, "Message type is attachment");
                // 微信返回的xml中有很多<br/>, 所以要先去掉
                let xmlText = decode(msg.text().replace(new RegExp("<br/>", "g"), ""));
                let xmlObj = parser.parse(xmlText);

                // archivebox
                if (wechatConversation.option.archivebox.enable) {
                    try {
                        let url: string;
                        url = xmlObj.msg.appmsg.url;
                        let archiveURL = await send2Archive(url);
                        if (archiveURL) {
                            await msg.say(archiveURL);
                        }
                    } catch (e: any) {
                        log.error(logPrefix, e);
                        await msg.say(e.message);
                    }
                }

                break;

            // 消息为普通文本, 从普通文本中提取url
            case bot.Message.Type.Text:
                log.info(logPrefix, "Message type is text");
                // 命令优先级最高, 且不会被其他功能处理
                if (await cmdInText(msg)) {
                    break;
                }

                //去掉所有的html标记
                let plainText = msgText.replace(/<[^>]+>/g, " ");

                // archivebox
                if (wechatConversation.option.archivebox.enable) {
                    // 数组去重
                    let urls = new Set(plainText.match(urlRegexSafe()));
                    urls.forEach(async (url) => {
                        let uriObj = URI.parse(url);
                        // 排除了已经有协议头和"//"开头的情况
                        if (!uriObj.scheme && !url.startsWith("//")) {
                            url = "http://" + url;
                            uriObj = URI.parse(url);
                        }
                        // 去掉过长的url, 否则archivebox会报错, 详见 https://github.com/ArchiveBox/ArchiveBox/issues/549
                        if (uriObj.host!.length >= 512) {
                            return;
                        }
                        log.info(logPrefix, "Send url to archivebox: %s", url);
                        try {
                            let archiveURL = await send2Archive(url);
                            if (archiveURL) {
                                await msg.say(archiveURL);
                            }
                        } catch (e: any) {
                            log.error(logPrefix, e);
                            await msg.say(e.message);
                        }
                    });
                    if (urls.size > 0) {
                        break;
                    }
                }

                // ChatGPT
                if (wechatConversation.option.chatgpt.enable) {
                    // ChatGPT
                    if (!ChatGPTSession.has(wechatConversation.id)) {
                        log.info(logPrefix, "Create new ChatGPT conversation");
                        let chatGPTConversation = newChatGPTConversation(chatGPT, wechatConversation);
                        ChatGPTSession.set(wechatConversation.id, chatGPTConversation);
                        wechatConversation.option.chatgpt.conversationId = chatGPTConversation.conversationId;
                        // dumpChatGPTSession();
                    }
                    let c = ChatGPTSession.get(wechatConversation.id)!;
                    log.info(logPrefix, "Send message to ChatGPT");
                    let resp: string | undefined;
                    try {
                        resp = await c.sendMessage(
                            plainText,
                            {
                                timeoutMs: config.chatgpt.timeout * 1000,
                            },
                            wechatConversation.type == "room" ? { name: msg.talker().name(), time: msg.date().toString(), mentionSelf: true } : undefined
                        );
                        if (resp) {
                            await msg.say(resp);
                        } else {
                            // 如果是个人对话，一定可以发送消息，如果是群聊中@，理论上也一定有消息，除非chatgpt不想。所以这里一般运行不到
                        }
                    } catch (e: any) {
                        if (!inRoom) {
                            switch (e.message) {
                                case "fetch failed":
                                    await msg.say("fetch failed, 请重新发送上一条消息");
                                    break;
                                default:
                                    await msg.say(e.message);
                                    break;
                            }
                        }
                        log.error(logPrefix, e);
                    }
                }

                break;

            case bot.Message.Type.Video:
                log.info(logPrefix, "Message type is video");
                break;

            // 希望用deepdanbooru识别图片内容
            case bot.Message.Type.Image:
                log.info(logPrefix, "Message type is image");
                // animepic
                if (wechatConversation.option.animepic.enable) {
                    let imgBox = await msg.toFileBox();
                    let img = await imgBox.toStream();
                    let formdata = new FormData();
                    formdata.append("img", img);
                    axios
                        .post(config.animepic.url, formdata)
                        .then(async (res) => {
                            let characters = "";
                            Object.keys(res.data.character).forEach((name) => {
                                characters += name + ",";
                            });
                            characters = characters.slice(0, -1);
                            let tags = "";
                            Object.keys(res.data.general).forEach((tag: string) => {
                                tags += tag + ",";
                            });
                            tags = tags.slice(0, -1);
                            let risk = "unknown";
                            if (Object.keys(res.data.system).length === 1) {
                                risk = Object.keys(res.data.system)[0].substring(7);
                            }
                            let imgInfo = `安全系数: ${risk}\n角色: ${characters}\n标签: ${tags}`;
                            await msg.say(imgInfo);
                        })
                        .catch(async (e) => {
                            log.error(logPrefix, e);
                            await msg.say(e.message);
                        });
                }

                break;
        }
    } else if (inRoom && replyEveryoneInRoom) {
        if (wechatConversation.option.chatgpt.enable && msg.type() == bot.Message.Type.Text) {
            log.info(logPrefix, "Message type is text");
            log.info(logPrefix, "replyEveryoneInRoom is enabled, will reply everyone in room");
            // ChatGPT
            if (!ChatGPTSession.has(wechatConversation.id)) {
                log.info(logPrefix, "Create new ChatGPT conversation");
                let chatGPTConversation = newChatGPTConversation(chatGPT, wechatConversation);
                ChatGPTSession.set(wechatConversation.id, chatGPTConversation);
                wechatConversation.option.chatgpt.conversationId = chatGPTConversation.conversationId;
                // dumpChatGPTSession();
            }
            let c = ChatGPTSession.get(wechatConversation.id)!;
            let text = msg.text();
            log.info(logPrefix, "Send message to ChatGPT");
            let resp: string | undefined;
            try {
                resp = await c.sendMessage(
                    text,
                    {
                        timeoutMs: config.chatgpt.timeout * 1000,
                    },
                    { name: msg.talker().name(), time: msg.date().toString(), mentionSelf: false }
                );
                if (resp) {
                    await msg.say(resp);
                }
            } catch (e: any) {
                switch (e.message) {
                    // 因为在群里, 所以出错时不再回复
                    case "fetch failed":
                        log.error(logPrefix, e);
                        // await msg.say("fetch failed, 请重新发送上一条消息");
                        break;
                    default:
                        log.error(logPrefix, e);
                        // await msg.say(e.message);
                        break;
                }
            }
        }
    } else {
        log.info(logPrefix, "Message is not (from friend or (from room and mentioned self) or (from room and replyEveryoneInRoom==true)), skip");
    }
}

async function onFriendship(friendship: Friendship) {
    let logPrefix = "Friendship";
    let contact = friendship.contact();
    try {
        log.info(logPrefix, "received friend event.");
        switch (friendship.type()) {
            // 1. New Friend Request
            case bot.Friendship.Type.Receive:
                if (friendship.hello() === config.wechat.autoAcceptFriendshipText) {
                    await friendship.accept();
                    log.info(logPrefix, `Request from ${contact.name()} is accept succesfully!`);
                    // log.info(logPrefix, contact.friend());
                } else {
                    log.info(logPrefix, `Request from ${contact.name()} is ignored!`);
                }
                break;

            // 2. Friend Ship Confirmed
            case bot.Friendship.Type.Confirm:
                log.info(logPrefix, `New friendship confirmed with ${contact.name()}`);
                break;
        }
    } catch (e) {
        log.error(logPrefix, e);
    }
}

const bot = WechatyBuilder.build({
    name: APPNAME,
    puppet: "wechaty-puppet-wechat",
    puppetOptions: {
        uos: true, // 开启uos协议
    },
    /**
     * How to set Wechaty Puppet Provider:
     *
     *  1. Specify a `puppet` option when instantiating Wechaty. (like `{ puppet: "wechaty-puppet-whatsapp" }`, see below)
     *  1. Set the `WECHATY_PUPPET` environment variable to the puppet NPM module name. (like `wechaty-puppet-whatsapp`)
     *
     * You can use the following providers locally:
     *  - wechaty-puppet-wechat (web protocol, no token required)
     *  - wechaty-puppet-whatsapp (web protocol, no token required)
     *  - wechaty-puppet-padlocal (pad protocol, token required)
     *  - etc. see: <https://wechaty.js.org/docs/puppet-providers/>
     */
    // puppet: "wechaty-puppet-whatsapp"

    /**
     * You can use wechaty puppet provider "wechaty-puppet-service"
     *   which can connect to remote Wechaty Puppet Services
     *   for using more powerful protocol.
     * Learn more about services (and TOKEN) from https://wechaty.js.org/docs/puppet-services/
     */
    // puppet: "wechaty-puppet-service"
    // puppetOptions: {
    //   token: "xxx",
    // }
});

bot.on("scan", onScan);
bot.on("login", onLogin);
bot.on("ready", onReady);
bot.on("logout", onLogout);
bot.on("message", onMessage);
// Friendship Event will emit when got a new friend request, or friendship is confirmed.
bot.on("friendship", onFriendship);

bot.start()
    .then(() => log.info("StarterBot", "Starter Bot Started."))
    .catch((e) => log.error("StarterBot", e));
