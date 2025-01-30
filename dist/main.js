import fs from "fs";
import YAML from "yaml";
import qrcodeTerminal from "qrcode-terminal";
import schedule from "node-schedule";
import nodemailer from "nodemailer";
import { ScanStatus, WechatyBuilder, log } from "wechaty";
import { ChatBot } from "./chatbot.js";
const configPath = "./config/config.yaml";
const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
let chatbot = new ChatBot(config);
// Wechat
const APPNAME = "wechat-bot";
let ReadyTime;
let MyWeChat;
let Jobs = new Map();
function msgFromFriend(msg) {
    // let notFriend = ["微信安全中心", "文件传输助手", "朋友推荐消息", "微信支付", "服务通知", "微信团队"];
    return !msg.self() && !msg.room() && msg.talker().type() == bot.Contact.Type.Individual && msg.talker().friend(); // && !notFriend.includes(msg.talker().name())
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
    if (config.wechat.botaccount == user.name()) {
        log.info("StarterBot", "account is correct");
    }
    else {
        log.error("StarterBot", "account is incorrect");
        process.exit(1);
    }
}
async function onReady() {
    ReadyTime = new Date();
    log.info("StarterBot", "bot is ready");
    chatbot.loadConversation("config/", async (c) => {
        if (c.type == "contact") {
            let contacts = await bot.Contact.findAll({ name: c.name });
            if (contacts.length == 1) {
                c.ID = contacts[0].id;
                return c;
            }
            else {
                contacts.forEach((contact) => {
                    if (contact.id == c.ID) {
                        // padlocal, id不变, 保存时的id和现在的contact id一致
                        return c;
                    }
                });
                return undefined;
            }
        }
        else if (c.type == "room") {
            let rooms = await bot.Room.findAll({ topic: c.name });
            if (rooms.length == 1) {
                c.ID = rooms[0].id;
                return c;
            }
            else {
                rooms.forEach((room) => {
                    if (room.id == c.ID) {
                        // padlocal, id不变, 保存时的id和现在的room id一致
                        return c;
                    }
                });
                return undefined;
            }
        }
    });
    MyWeChat = await bot.Contact.find(config.wechat.myaccount);
    if (!MyWeChat) {
        throw new Error(`Account ${config.wechat.myaccount} not found`);
    }
    // 已确认MyWeChat不为undefined
    let report = schedule.scheduleJob({
        rule: config.wechat.reportTime.cron,
    }, async () => {
        await MyWeChat.say(`正常工作喵`);
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
    if (msg.self()) {
        return;
    }
    // 只回复ReadyTime之后的消息
    if (!ReadyTime || msg.date() < ReadyTime) {
        log.info(logPrefix, "Message Date=%s, ReadyTime=%s, skip", msg.date(), ReadyTime);
        return;
    }
    let responseQueue;
    let room = msg.room();
    if (room) {
        let roomID = room.id;
        let roomName = await room.topic();
        let c = chatbot.getConversation(roomID, roomName, "room");
        let originalMessage = {
            conversation: c,
            senderName: msg.talker().name(),
            type: "room",
            time: msg.date(),
            mentionSelf: await msg.mentionSelf(),
            content: msg.text(),
        };
        responseQueue = await chatbot.receiveMessage(originalMessage);
    }
    else {
        if (!msgFromFriend(msg)) {
            return;
        }
        let talker = msg.talker();
        let c = chatbot.getConversation(talker.id, talker.name(), "contact");
        let originalMessage = {
            conversation: c,
            senderName: talker.name(),
            type: "contact",
            time: msg.date(),
            mentionSelf: false,
            content: msg.text(),
        };
        responseQueue = await chatbot.receiveMessage(originalMessage);
    }
    for (let r of responseQueue) {
        msg.say(r.content);
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