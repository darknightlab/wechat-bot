import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import YAML from "yaml";
import { TSMap } from "typescript-map";
import urlRegexSafe from "url-regex-safe";
import qrcodeTerminal from "qrcode-terminal";
import schedule from "node-schedule";
import * as URI from "uri-js";
import nodemailer from "nodemailer";
import { ScanStatus, WechatyBuilder, log } from "wechaty";
import { XMLParser } from "fast-xml-parser";
import { decode } from "html-entities";
import { execSync } from "node:child_process";
import { ChatGPTAPI } from "chatgpt";
// 实现的不好看
// 为了在外部控制promise的resolve和reject, 详见 https://stackoverflow.com/questions/26150232/resolve-javascript-promise-outside-the-promise-constructor-scope
class Task {
    _resolve = () => { };
    _reject = () => { };
    _promise;
    constructor(executor) {
        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
            executor(resolve, reject);
        });
    }
    result() {
        return this._promise;
    }
    resolve(value) {
        this._resolve(value);
    }
    reject(reason) {
        this._reject(reason);
    }
}
const parser = new XMLParser();
const configPath = "./config/config.yaml";
const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
// Wechat
const APPNAME = "wechat-bot";
const Command = new Map([
    ["chatgpt", cmd_chatgpt],
    ["auth", cmd_auth],
    ["archive", cmd_archive],
    ["animepic", cmd_animepic],
    ["test", cmd_test],
]);
let StartTime = new Date();
let MyWeChat;
let AuthedID = new Set();
let Jobs = new Map();
let MsgQueue = new Map();
let WechatConversationOptions = new Map();
let DefaultWechatConversationOption = {
    chatgpt: {
        enable: config.chatgpt.enable,
    },
    archivebox: {
        enable: config.archive.enable,
    },
    animepic: {
        enable: config.animepic.enable,
    },
};
async function middleware(msg) {
    return msg;
}
function isAuthed(id) {
    return AuthedID.has(id);
}
async function getWechatConversation(msg) {
    let id = msg.room() ? msg.room().id : msg.talker().id;
    let name = msg.room() ? await msg.room().topic() : msg.talker().name();
    let type = msg.room() ? "room" : "contact";
    let res = {
        id: id,
        name: name,
        type: type,
    };
    return res;
}
function msgFromFriend(msg) {
    // let notFriend = ["微信安全中心", "文件传输助手", "朋友推荐消息", "微信支付", "服务通知", "微信团队"];
    return !msg.self() && !msg.room() && msg.talker().type() == bot.Contact.Type.Individual && msg.talker().friend(); // && !notFriend.includes(msg.talker().name())
}
function msgFromRoom(msg) {
    return !msg.self() && msg.room();
}
function nextMessage(one) {
    // 如果不存在该联系人的队列, 用id创建一个.
    if (!MsgQueue.has(one.id)) {
        MsgQueue.set(one.id, []);
    }
    let msgList = MsgQueue.get(one.id);
    let task = new Task((resolve) => { });
    msgList.push(task);
    return task;
}
// 检测文本是否包含命令
async function cmdInText(msg) {
    let text = await msg.mentionText();
    let textList = text.split(" ");
    if (textList[0].startsWith("/")) {
        let cmd = textList[0].slice(1);
        if (Command.has(cmd)) {
            try {
                await Command.get(cmd)(textList.slice(1), msg);
            }
            catch (e) {
                await msg.say(e.message);
            }
        }
        else {
            await msg.say(`未知命令: /${cmd}`);
        }
        return true;
    }
    return false;
}
async function cmd_auth(args, msg) {
    // 认证用个人, 群组不行
    if (AuthedID.has(msg.talker().id)) {
        await msg.say("已认证");
    }
    else {
        if (args.length === 1 && args[0] === config.wechat.authPassword) {
            AuthedID.add(msg.talker().id);
            await msg.say("认证成功");
        }
        else {
            await msg.say("认证失败");
        }
    }
}
async function cmd_chatgpt(args, msg) {
    let wechatConversation = await getWechatConversation(msg);
    if (args.length > 0) {
        switch (args[0]) {
            case "clear":
                ChatGPTSession.set(wechatConversation.id, getChatGPTConversation(chatGPT, wechatConversation));
                dumpChatGPTSession();
                await msg.say("已清空聊天记录");
                break;
            case "recover": // 恢复chatgpt会话
                if (args.length == 2) {
                    let name = args[1];
                    let tmpl = conversationTmpls.get(name);
                    if (!tmpl) {
                        await msg.say(`未找到会话模板: ${name}`);
                    }
                    if (!ChatGPTSession.has(wechatConversation.id)) {
                        log.info("cmd_chatgpt", "Create new ChatGPT conversation");
                        ChatGPTSession.set(wechatConversation.id, getChatGPTConversation(chatGPT, wechatConversation));
                    }
                    let session = ChatGPTSession.get(wechatConversation.id);
                    session.conversationId = tmpl.convesationId;
                    session.messageIdList = [...tmpl.messageIdList];
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
                    let getMessageMapOfConversation = () => {
                        let res = new TSMap();
                        session.messageIdList.forEach((messageId) => {
                            let chatMessage = MessageMap.get(messageId);
                            res.set(messageId, chatMessage);
                            res.set(chatMessage.parentMessageId, MessageMap.get(chatMessage.parentMessageId));
                        });
                        return res;
                    };
                    let tmpl = {
                        convesationId: session.conversationId,
                        messageIdList: [...session.messageIdList],
                        messageMap: getMessageMapOfConversation(),
                    };
                    conversationTmpls.set(name, tmpl);
                    dumpConversationTmpl();
                    await msg.say("已保存");
                }
                break;
            case "tmpl":
                if (args.length == 2) {
                    // 列出模板
                    if (args[1] === "list") {
                        let res = "";
                        conversationTmpls.forEach((tmpl, name) => {
                            res += name + " ";
                        });
                        res = res.trim();
                        await msg.say(res);
                    }
                }
            case "disable":
                // 已经确定WechatConversationOptions存在id
                WechatConversationOptions.get(wechatConversation.id).chatgpt.enable = false;
                if (ChatGPTSession.has(wechatConversation.id)) {
                    ChatGPTSession.delete(wechatConversation.id);
                }
                break;
            case "enable":
                // 已经确定wechatConversationOptions存在id
                WechatConversationOptions.get(wechatConversation.id).chatgpt.enable = true;
                break;
            default:
                // 命令错误
                await msg.say("/chatgpt [clear|recover|save|enable|disable]");
                break;
        }
    }
    else {
        await msg.say("/chatgpt [clear|recover|save|enable|disable]");
    }
}
async function cmd_archive(args, msg) {
    let wechatConversation = await getWechatConversation(msg);
    if (args.length > 0) {
        switch (args[0]) {
            case "enable":
                WechatConversationOptions.get(wechatConversation.id).archivebox.enable = true;
                break;
            case "disable":
                WechatConversationOptions.get(wechatConversation.id).archivebox.enable = false;
                break;
            default:
                await msg.say("/archive [enable|disable]");
                break;
        }
    }
}
async function cmd_animepic(args, msg) {
    let wechatConversation = await getWechatConversation(msg);
    if (args.length > 0) {
        switch (args[0]) {
            case "enable":
                WechatConversationOptions.get(wechatConversation.id).animepic.enable = true;
                break;
            case "disable":
                WechatConversationOptions.get(wechatConversation.id).animepic.enable = false;
                break;
            default:
                await msg.say("/animepic [enable|disable]");
                break;
        }
    }
}
async function cmd_test(args, msg) {
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
let TodayPostsSaved = new Set();
async function send2Archive(url) {
    let resultStr = execSync(config.archive.command, {
        env: {
            URL: url,
            ARCHIVE_DISPLAY_MODE: config.archive.displayMode,
            ARCHIVE_URL: config.archive.url,
            ARCHIVE_LOCAL_URL: config.archive.localurl,
            ARCHIVE_USERNAME: config.archive.username,
            ARCHIVE_PASSWORD: config.archive.password,
        },
    }).toString("utf8");
    let result = JSON.parse(resultStr);
    if (result.hasOwnProperty("status") && result.status === "success") {
        TodayPostsSaved.add(result.url);
        return result.url;
    }
    else {
        return null;
    }
}
let chatGPT = new ChatGPTAPI({
    apiKey: config.chatgpt.apiKey,
    getMessageById: getMessageById,
    upsertMessage: upsertMessage,
});
let ChatGPTSession = new Map();
let MessageMap = new TSMap();
let conversationTmpls = new TSMap();
async function getMessageById(id) {
    return MessageMap.get(id);
}
async function upsertMessage(message) {
    MessageMap.set(message.id, message);
    // dump
    fs.writeFileSync(`config/${APPNAME}.message.chatgpt.json`, JSON.stringify(MessageMap.toJSON()));
}
function dumpConversationTmpl() {
    fs.writeFileSync(`config/${APPNAME}.template.chatgpt.json`, JSON.stringify(conversationTmpls.toJSON()));
}
// 储存ChatGPTSession到文本
function dumpChatGPTSession() {
    // session
    // chatgptsession是id到对话的映射, 而存储到json后是包含id和名字的数组. chatgptconversation当中还含有联系人的名字. 恢复时利用名字恢复.
    let session = [];
    ChatGPTSession.forEach((v) => {
        session.push({
            wechatConversation: v.wechatConversation,
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
async function loadChatGPT(api = chatGPT) {
    // session
    try {
        let str = fs.readFileSync(`config/${APPNAME}.session.chatgpt.json`).toString("utf8");
        let obj = JSON.parse(str);
        if (obj.account == bot.currentUser.name()) {
            let session = obj.session;
            session.forEach(async (v) => {
                let c = new ChatGPTConversation(api, v.wechatConversation);
                c.conversationId = v.conversationId;
                c.messageIdList = v.messageIdList;
                if (v.wechatConversation.type == "contact") {
                    let contacts = await bot.Contact.findAll({ name: v.wechatConversation.name });
                    if (contacts.length == 1) {
                        ChatGPTSession.set(contacts[0].id, c);
                    }
                    else {
                        contacts.forEach((contact) => {
                            if (contact.id == v.wechatConversation.id) {
                                // 如果有多个同名联系人且是padlocal, 则可以使用contactId来区分
                                ChatGPTSession.set(contact.id, c);
                            }
                        });
                        log.warn("ChatGPT", `无法找到或有多个同名联系人${v.wechatConversation.name}, 会话无法恢复`);
                    }
                }
                else if (v.wechatConversation.type == "room") {
                    let rooms = await bot.Room.findAll({ topic: v.wechatConversation.name });
                    if (rooms.length == 1) {
                        ChatGPTSession.set(rooms[0].id, c);
                    }
                    else {
                        rooms.forEach((room) => {
                            if (room.id == v.wechatConversation.id) {
                                // 如果有多个同名群且是padlocal, 则可以使用roomId来区分
                                ChatGPTSession.set(room.id, c);
                            }
                        });
                        log.warn("ChatGPT", `无法找到或有多个同名群${v.wechatConversation.name}, 会话无法恢复`);
                    }
                }
            });
        }
    }
    catch (e) {
        log.info("ChatGPT", e.message);
    }
    // message
    try {
        let str = fs.readFileSync(`config/${APPNAME}.message.chatgpt.json`).toString("utf8");
        let obj = JSON.parse(str);
        MessageMap = new TSMap().fromJSON(obj);
    }
    catch (e) {
        log.info("ChatGPT", e.message);
    }
    // template
    try {
        let str = fs.readFileSync(`config/${APPNAME}.template.chatgpt.json`).toString("utf8");
        let obj = JSON.parse(str);
        Object.keys(obj).forEach((name) => {
            let tmpl = {
                convesationId: obj[name].convesationId,
                messageIdList: obj[name].messageIdList,
                messageMap: new TSMap().fromJSON(obj[name].messageMap),
            };
            conversationTmpls.set(name, tmpl);
        });
    }
    catch (e) {
        log.info("ChatGPT", e.message);
    }
    conversationTmpls.forEach((tmpl, name) => {
        tmpl.messageMap.forEach((chatMessage, id) => {
            MessageMap.set(id, chatMessage);
        });
    });
}
function getChatGPTConversation(api, wechatC) {
    return new ChatGPTConversation(api, wechatC);
}
class ChatGPTConversation {
    wechatConversation;
    conversationId = undefined;
    messageIdList;
    _api;
    constructor(api, wechatC) {
        this._api = api;
        this.wechatConversation = wechatC;
        this.messageIdList = [];
    }
    async sendMessage(message, opts = {}) {
        if (this.conversationId && !opts.conversationId) {
            opts.conversationId = this.conversationId;
        }
        // 这里的逻辑是, 当群聊中有两个人在很接近的时间之内连发两条消息, 则他们都以这之前的最后一条ai消息作为上文.
        if (this.messageIdList.length > 0 && !opts.parentMessageId) {
            opts.parentMessageId = this.messageIdList[this.messageIdList.length - 1];
        }
        let response = await this._api.sendMessage(message, opts);
        this.messageIdList.push(response.id);
        if (!this.conversationId) {
            this.conversationId = response.conversationId;
        }
        dumpChatGPTSession();
        return response;
    }
}
// Wechaty 事件
async function onScan(qrcode, status) {
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
        }
        catch (e) {
            log.error("SendMail", e);
        }
        qrcodeTerminal.generate(qrcode, { small: true }); // show qrcode on console
    }
    else {
        log.info("StarterBot", "onScan: %s(%s)", ScanStatus[status], status);
    }
}
async function onLogin(user) {
    log.info("StarterBot", "%s login", user);
}
async function onReady() {
    log.info("StarterBot", "bot is ready");
    loadChatGPT(chatGPT);
    MyWeChat = await bot.Contact.find(config.wechat.myaccount);
    if (!MyWeChat) {
        throw new Error(`Account ${config.wechat.myaccount} not found`);
    }
    // 已确认MyWeChat不为undefined
    let report = schedule.scheduleJob({
        rule: config.wechat.reportTime.cron,
        tz: config.wechat.reportTime.timezone,
    }, async () => {
        await MyWeChat.say(`统计时间内已存档${TodayPostsSaved.size}个网页`);
        TodayPostsSaved.clear();
    });
    // Jobs.get("report")
    Jobs.set("report", report);
    log.info("StarterBot", `report job scheduled, will send it to ${MyWeChat.name()}`);
}
function onLogout(user) {
    log.info("StarterBot", "%s logout", user);
}
async function onMessage(msg) {
    let logPrefix = "Message";
    log.info(logPrefix, msg.toString());
    // 只回复StartTime之后的消息
    if (msg.date() < StartTime) {
        log.info(logPrefix, "Message Date=%s, StartTime=%s, skip", msg.date(), StartTime);
        return;
    }
    // 只回复好友或者在群里面at自己的消息
    if (!(msgFromFriend(msg) || (msgFromRoom(msg) && (await msg.mentionSelf())))) {
        log.info(logPrefix, "Message is not from friend or from room but not mentioned self, skip");
        return;
    }
    let wechatConversation = await getWechatConversation(msg); // 实际上是Contact|Room
    let msgText = await msg.mentionText();
    // 优先级高于命令!! 例如在等待消息的过程中, 尽管接收到的是disable的命令, 也会因为这里的return而跳过.
    // 如果有等待消息的队列, 则捕捉消息
    if (MsgQueue.has(wechatConversation.id)) {
        let queue = MsgQueue.get(wechatConversation.id);
        if (queue.length > 0) {
            let p = queue.shift();
            p.resolve(msg);
            return;
        }
    }
    let wechatConversationOption;
    if (WechatConversationOptions.has(wechatConversation.id)) {
        wechatConversationOption = WechatConversationOptions.get(wechatConversation.id);
    }
    else {
        wechatConversationOption = DefaultWechatConversationOption;
        WechatConversationOptions.set(wechatConversation.id, wechatConversationOption);
    }
    switch (msg.type()) {
        // 消息属于类似公众号的美观链接
        case bot.Message.Type.Attachment:
            log.info(logPrefix, "Message type is attachment");
            // 微信返回的xml中有很多<br/>, 所以要先去掉
            let xmlText = decode(msg.text().replace(new RegExp("<br/>", "g"), ""));
            let xmlObj = parser.parse(xmlText);
            // archivebox
            if (wechatConversationOption.archivebox.enable) {
                try {
                    let url;
                    url = xmlObj.msg.appmsg.url;
                    let archiveURL = await send2Archive(url);
                    if (archiveURL) {
                        await msg.say(archiveURL);
                    }
                }
                catch (e) {
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
            if (wechatConversationOption.archivebox.enable) {
                // 数组去重
                let urls = new Set(plainText.match(urlRegexSafe()));
                urls.forEach(async (url) => {
                    let uriObj = URI.parse(url);
                    // 排除了已经有协议头和"//"开头的情况
                    if (!uriObj.scheme && !url.startsWith("//")) {
                        url = "http://" + url;
                    }
                    // 去掉过长的url, 否则archivebox会报错, 详见 https://github.com/ArchiveBox/ArchiveBox/issues/549
                    if (uriObj.host.length >= 512) {
                        return;
                    }
                    log.info(logPrefix, "Send url to archivebox: %s", url);
                    try {
                        let archiveURL = await send2Archive(url);
                        if (archiveURL) {
                            await msg.say(archiveURL);
                        }
                    }
                    catch (e) {
                        log.error(logPrefix, e);
                        await msg.say(e.message);
                    }
                });
            }
            // ChatGPT
            if (wechatConversationOption.chatgpt.enable) {
                // ChatGPT
                if (!ChatGPTSession.has(wechatConversation.id)) {
                    log.info(logPrefix, "Create new ChatGPT conversation");
                    ChatGPTSession.set(wechatConversation.id, getChatGPTConversation(chatGPT, wechatConversation));
                }
                let c = ChatGPTSession.get(wechatConversation.id);
                log.info(logPrefix, "Send message to ChatGPT");
                let resp;
                try {
                    resp = await c.sendMessage(plainText, {
                        timeoutMs: config.chatgpt.timeout * 1000,
                    });
                    await msg.say(resp.text);
                }
                catch (e) {
                    switch (e.message) {
                        case "fetch failed":
                            log.error(logPrefix, e);
                            await msg.say("fetch failed, 请重新发送上一条消息");
                        default:
                            log.error(logPrefix, e);
                            await msg.say(e.message);
                            break;
                    }
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
            if (wechatConversationOption.animepic.enable) {
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
                    Object.keys(res.data.general).forEach((tag) => {
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
}
async function onFriendship(friendship) {
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
                }
                else {
                    log.info(logPrefix, `Request from ${contact.name()} is ignored!`);
                }
                break;
            // 2. Friend Ship Confirmed
            case bot.Friendship.Type.Confirm:
                log.info(logPrefix, `New friendship confirmed with ${contact.name()}`);
                break;
        }
    }
    catch (e) {
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
//# sourceMappingURL=main.js.map