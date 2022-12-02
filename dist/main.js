"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const yaml_1 = __importDefault(require("yaml"));
const url_regex_safe_1 = __importDefault(require("url-regex-safe"));
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const node_schedule_1 = __importDefault(require("node-schedule"));
const URI = __importStar(require("uri-js"));
const nodemailer_1 = __importDefault(require("nodemailer"));
const wechaty_1 = require("wechaty");
const fast_xml_parser_1 = require("fast-xml-parser");
const html_entities_1 = require("html-entities");
const node_child_process_1 = require("node:child_process");
const parser = new fast_xml_parser_1.XMLParser();
const configPath = "./config/config.yaml";
const configFile = fs_1.default.readFileSync(configPath, "utf8");
const config = yaml_1.default.parse(configFile);
// qrcodeAPIURL 已被config.wechat.qrcodeAPI替代
// const qrcodeAPIURL = "https://api.qrserver.com/v1/create-qr-code/?data="; // "https://wechaty.js.org/qrcode/" wechaty 自带接口
const transporter = nodemailer_1.default.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.port == 465,
    auth: {
        user: config.email.username,
        pass: config.email.password,
    },
});
let MyWeChat;
let Jobs = new Map();
let TodayPostsSaved = new Set();
let LastMailTime = (() => {
    let now = new Date();
    now.setTime(now.getTime() - config.email.interval * 1000);
    return now;
})();
function onScan(qrcode, status) {
    if (status === wechaty_1.ScanStatus.Waiting || status === wechaty_1.ScanStatus.Timeout) {
        const qrcodeImageUrl = [config.wechat.qrcodeAPI, encodeURIComponent(qrcode)].join("");
        wechaty_1.log.info("StarterBot", "onScan: %s(%s) - %s", wechaty_1.ScanStatus[status], status, qrcodeImageUrl);
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
                wechaty_1.log.info("StarterBot", "onScan: Send mail successfully");
            }
        }
        catch (e) {
            wechaty_1.log.error("SendMail", e);
        }
        qrcode_terminal_1.default.generate(qrcode, { small: true }); // show qrcode on console
    }
    else {
        wechaty_1.log.info("StarterBot", "onScan: %s(%s)", wechaty_1.ScanStatus[status], status);
    }
}
function send2Archive(url) {
    return __awaiter(this, void 0, void 0, function* () {
        let resultStr = (0, node_child_process_1.execSync)(config.archive.command, {
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
    });
}
function msgFromFriend(msg) {
    return !msg.self() && !msg.room() && msg.talker().friend();
}
function onLogin(user) {
    return __awaiter(this, void 0, void 0, function* () {
        wechaty_1.log.info("StarterBot", "%s login", user);
    });
}
function onReady() {
    return __awaiter(this, void 0, void 0, function* () {
        wechaty_1.log.info("StarterBot", "bot is ready");
        MyWeChat = yield bot.Contact.find(config.wechat.myaccount);
        if (!MyWeChat) {
            throw new Error(`Account ${config.wechat.myaccount} not found`);
        }
        let rule = new node_schedule_1.default.RecurrenceRule();
        // rule.hour = config.wechat.reportTime.hour;
        // rule.minute = config.wechat.reportTime.minute;
        // rule.second = config.wechat.reportTime.second;
        rule.tz = config.wechat.reportTime.timezone;
        // 已确认MyWeChat不为undefined
        let report = node_schedule_1.default.scheduleJob(rule, () => __awaiter(this, void 0, void 0, function* () {
            yield MyWeChat.say(`今日已存档${TodayPostsSaved.size}个网页`);
        }));
        report.reschedule(rule);
        // Jobs.get("report")
        Jobs.set("report", report);
        wechaty_1.log.info("StarterBot", `report job scheduled, will send it to ${MyWeChat.name()}`);
    });
}
function onLogout(user) {
    wechaty_1.log.info("StarterBot", "%s logout", user);
}
function onMessage(msg) {
    return __awaiter(this, void 0, void 0, function* () {
        let logPrefix = "Message";
        wechaty_1.log.info(logPrefix, msg.toString());
        if (msgFromFriend(msg)) {
            switch (msg.type()) {
                // 消息属于类似公众号的美观链接
                case bot.Message.Type.Attachment:
                    // 微信返回的xml中有很多<br/>, 所以要先去掉
                    let xmlText = (0, html_entities_1.decode)(msg.text().replace(new RegExp("<br/>", "g"), ""));
                    let xmlObj = parser.parse(xmlText);
                    try {
                        let url;
                        url = xmlObj.msg.appmsg.url;
                        let archiveURL = yield send2Archive(url);
                        if (archiveURL) {
                            yield msg.say(archiveURL);
                        }
                    }
                    catch (e) {
                        wechaty_1.log.error(logPrefix, e);
                        msg.say(e.message);
                    }
                    break;
                // 消息为普通文本, 从普通文本中提取url
                case bot.Message.Type.Text:
                    //去掉所有的html标记
                    let plainText = msg.text().replace(/<[^>]+>/g, " ");
                    // 数组去重
                    let urls = new Set(plainText.match((0, url_regex_safe_1.default)()));
                    urls.forEach((url) => __awaiter(this, void 0, void 0, function* () {
                        let uriObj = URI.parse(url);
                        // 排除了已经有协议头和"//"开头的情况
                        if (!uriObj.scheme && !url.startsWith("//")) {
                            url = "http://" + url;
                        }
                        try {
                            let archiveURL = yield send2Archive(url);
                            if (archiveURL) {
                                yield msg.say(archiveURL);
                            }
                        }
                        catch (e) {
                            wechaty_1.log.error(logPrefix, e);
                            msg.say(e.message);
                        }
                    }));
                    break;
                case bot.Message.Type.Video:
                    break;
                // 希望用deepdanbooru识别图片内容
                case bot.Message.Type.Image:
                    let imgBox = yield msg.toFileBox();
                    let img = yield imgBox.toStream();
                    let formdata = new form_data_1.default();
                    formdata.append("img", img);
                    axios_1.default
                        .post(config.animepic.url, formdata)
                        .then((res) => {
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
                        let imgInfo = `安全系数: ${Object.keys(res.data.system)[0].substring(7)}\n角色: ${characters}\n标签: ${tags}`;
                        msg.say(imgInfo);
                    })
                        .catch((e) => {
                        wechaty_1.log.error(logPrefix, e);
                        msg.say(e.message);
                    });
                    break;
            }
        }
    });
}
function onFriendship(friendship) {
    return __awaiter(this, void 0, void 0, function* () {
        let logPrefix = "Friendship";
        let contact = friendship.contact();
        try {
            wechaty_1.log.info(logPrefix, "received friend event.");
            switch (friendship.type()) {
                // 1. New Friend Request
                case bot.Friendship.Type.Receive:
                    if (friendship.hello() === config.wechat.autoAcceptFriendshipText) {
                        yield friendship.accept();
                        wechaty_1.log.info(logPrefix, `Request from ${contact.name()} is accept succesfully!`);
                        // log.info(logPrefix, contact.friend());
                    }
                    else {
                        wechaty_1.log.info(logPrefix, `Request from ${contact.name()} is ignored!`);
                    }
                    break;
                // 2. Friend Ship Confirmed
                case bot.Friendship.Type.Confirm:
                    wechaty_1.log.info(logPrefix, `New friendship confirmed with ${contact.name()}`);
                    break;
            }
        }
        catch (e) {
            wechaty_1.log.error(logPrefix, e);
        }
    });
}
const bot = wechaty_1.WechatyBuilder.build({
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
    .then(() => wechaty_1.log.info("StarterBot", "Starter Bot Started."))
    .catch((e) => wechaty_1.log.error("StarterBot", e));
//# sourceMappingURL=main.js.map