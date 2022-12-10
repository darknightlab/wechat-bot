import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import YAML from "yaml";
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
const Command = new Map([
    ["chatgpt", cmd_chatgpt],
    ["auth", cmd_auth],
    ["archive", cmd_archive],
    ["animepic", cmd_animepic],
    ["test", cmd_test],
]);
let MyWeChat;
let AuthedID = new Set();
let Jobs = new Map();
let MsgQueue = new Map();
let ContactOptions = new Map();
let DefaultContactOption = {
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
function isAuthed(id) {
    return AuthedID.has(id);
}
function msgFromFriend(msg) {
    return !msg.self() && !msg.room() && msg.talker().friend();
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
    let text = msg.text();
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
            await msg.say(`未知命令: ${cmd}`);
        }
        return true;
    }
    return false;
}
async function cmd_auth(args, msg) {
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
    if (args.length > 0) {
        switch (args[0]) {
            case "reset":
                ChatGPTSession.set(msg.talker().id, chatGPT.getConversation());
                break;
            case "refresh": // 需要认证
                if (!isAuthed(msg.talker().id)) {
                    await msg.say("未认证, 请输入/auth [password]进行认证");
                    break;
                }
                // let token_backup: string = (chatGPT as any)._sessionToken;
                // let token = await chatGPT.ensureAuth();
                // msg.say(`token: ${token}`);
                // config.chatgpt.session_token = token;
                // fs.writeFileSync(configPath, YAML.stringify(config));
                // 成功则是token, 不成功则是报错信息
                await msg.say(refreshSessionToken());
                break;
            case "settoken": // 需要认证
                if (!isAuthed(msg.talker().id)) {
                    await msg.say("未认证, 请输入/auth [password]进行认证");
                    break;
                }
                if (args.length === 2) {
                    chatGPT._sessionToken = args[1];
                    config.chatgpt.session_token = args[1];
                    fs.writeFileSync(configPath, YAML.stringify(config));
                    await msg.say("设置成功");
                }
                break;
            case "disable":
                // 已经确定contactoptions存在id
                ContactOptions.get(msg.talker().id).chatgpt.enable = false;
                if (ChatGPTSession.has(msg.talker().id)) {
                    ChatGPTSession.delete(msg.talker().id);
                }
                break;
            case "enable":
                // 已经确定contactoptions存在id
                ContactOptions.get(msg.talker().id).chatgpt.enable = true;
                break;
            default:
                // 命令错误
                await msg.say("chatgpt [reset|refresh|settoken|enable|disable]");
                break;
        }
    }
    else {
        await msg.say("chatgpt [reset]");
    }
}
async function cmd_archive(args, msg) {
    if (args.length > 0) {
        switch (args[0]) {
            case "enable":
                ContactOptions.get(msg.talker().id).archivebox.enable = true;
                break;
            case "disable":
                ContactOptions.get(msg.talker().id).archivebox.enable = false;
                break;
            default:
                await msg.say("archive [enable|disable]");
        }
    }
}
async function cmd_animepic(args, msg) {
    if (args.length > 0) {
        switch (args[0]) {
            case "enable":
                ContactOptions.get(msg.talker().id).animepic.enable = true;
                break;
            case "disable":
                ContactOptions.get(msg.talker().id).animepic.enable = false;
                break;
            default:
                await msg.say("animepic [enable|disable]");
        }
    }
}
async function cmd_test(args, msg) {
    await msg.say("请在下一条消息中发送任意内容");
    let nextMsg = await nextMessage(msg.talker()).result();
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
// ChatGPT
let chatGPT = new ChatGPTAPI({
    sessionToken: config.chatgpt.session_token,
    markdown: true,
});
let ChatGPTSession = new Map();
function getSessionToken() {
    let token = execSync(config.chatgpt.command, {
        env: {
            HTTP_PROXY: config.chatgpt.proxy,
            HTTPS_PROXY: config.chatgpt.proxy,
            CHATGPT_USERNAME: config.chatgpt.username,
            CHATGPT_PASSWORD: config.chatgpt.password,
        },
    }).toString("utf8");
    return token;
}
function refreshSessionToken() {
    let token = getSessionToken();
    if (token.startsWith("Error")) {
        return token;
    }
    else {
        chatGPT._sessionToken = token;
        config.chatgpt.session_token = token;
        fs.writeFileSync(configPath, YAML.stringify(config));
        return `token: ${token}`;
    }
}
// Wechaty 事件
function onScan(qrcode, status) {
    if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
        const qrcodeImageUrl = [config.wechat.qrcodeAPI, encodeURIComponent(qrcode)].join("");
        log.info("StarterBot", "onScan: %s(%s) - %s", ScanStatus[status], status, qrcodeImageUrl);
        // 如果到达允许的邮件间隔时间, 发送二维码邮件
        try {
            if (new Date().getTime() - LastMailTime.getTime() > config.email.interval * 1000) {
                transporter.sendMail({
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
    let talker = msg.talker();
    // 优先级高于命令!! 例如在等待消息的过程中, 尽管接收到的是disable的命令, 也会因为这里的return而跳过.
    // 如果有等待消息的队列, 则捕捉消息
    if (MsgQueue.has(talker.id)) {
        let queue = MsgQueue.get(talker.id);
        if (queue.length > 0) {
            let p = queue.shift();
            p.resolve(msg);
            return;
        }
    }
    let contactOption;
    if (ContactOptions.has(talker.id)) {
        contactOption = ContactOptions.get(talker.id);
    }
    else {
        contactOption = DefaultContactOption;
        ContactOptions.set(talker.id, contactOption);
    }
    if (msgFromFriend(msg)) {
        switch (msg.type()) {
            // 消息属于类似公众号的美观链接
            case bot.Message.Type.Attachment:
                // 微信返回的xml中有很多<br/>, 所以要先去掉
                let xmlText = decode(msg.text().replace(new RegExp("<br/>", "g"), ""));
                let xmlObj = parser.parse(xmlText);
                // archivebox
                if (contactOption.archivebox.enable) {
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
                // 命令优先级最高, 且不会被其他功能处理
                if (await cmdInText(msg)) {
                    break;
                }
                //去掉所有的html标记
                let plainText = msg.text().replace(/<[^>]+>/g, " ");
                // archivebox
                if (contactOption.archivebox.enable) {
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
                if (contactOption.chatgpt.enable) {
                    // ChatGPT
                    if (!ChatGPTSession.has(talker.id)) {
                        ChatGPTSession.set(talker.id, chatGPT.getConversation());
                    }
                    let c = ChatGPTSession.get(talker.id);
                    let resp;
                    try {
                        resp = await c.sendMessage(plainText, {
                            timeoutMs: config.chatgpt.timeout * 1000,
                        });
                        await msg.say(resp);
                    }
                    catch (e) {
                        switch (e.message) {
                            case "ChatGPT failed to refresh auth token. Error: session token may have expired":
                                refreshSessionToken();
                                await msg.say("Session Token已过期, 正在尝试刷新Session Token, 请重新发送消息");
                            default:
                                log.error(logPrefix, e);
                                await msg.say(e.message);
                        }
                    }
                }
                break;
            case bot.Message.Type.Video:
                break;
            // 希望用deepdanbooru识别图片内容
            case bot.Message.Type.Image:
                // animepic
                if (contactOption.animepic.enable) {
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
    name: "wechat-bot",
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