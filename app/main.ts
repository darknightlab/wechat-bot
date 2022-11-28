import { Contact, Message, ScanStatus, WechatyBuilder, log, Friendship } from "wechaty";
import { XMLParser, XMLBuilder, XMLValidator } from "fast-xml-parser";
import { decode } from "html-entities";
import { execSync, spawn } from "node:child_process";
import * as URI from "uri-js";
import fs from "fs";
import axios from "axios";
import FormData from "form-data";
import YAML from "yaml";
import urlRegexSafe from "url-regex-safe";
import qrcodeTerminal from "qrcode-terminal";

const parser = new XMLParser();

const configPath = "./config/config.yaml";
const configFile = fs.readFileSync(configPath, "utf8");
const config = YAML.parse(configFile);

function onScan(qrcode: string, status: ScanStatus) {
    if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
        const qrcodeImageUrl = ["https://wechaty.js.org/qrcode/", encodeURIComponent(qrcode)].join("");
        log.info("StarterBot", "onScan: %s(%s) - %s", ScanStatus[status], status, qrcodeImageUrl);

        // todo: 发送二维码到邮箱

        qrcodeTerminal.generate(qrcode, { small: true }); // show qrcode on console
    } else {
        log.info("StarterBot", "onScan: %s(%s)", ScanStatus[status], status);
    }
}

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
        return result.url as string;
    } else {
        return null;
    }
}

function msgFromFriend(msg: Message) {
    return !msg.self() && msg.listener() && msg.listener()!.friend();
}

function onLogin(user: Contact) {
    log.info("StarterBot", "%s login", user);
}

function onLogout(user: Contact) {
    log.info("StarterBot", "%s logout", user);
}

async function onMessage(msg: Message) {
    let logPrefix = "Message";
    log.info(logPrefix, msg.toString());

    if (msgFromFriend(msg)) {
        switch (msg.type()) {
            // 消息属于类似公众号的美观链接
            case bot.Message.Type.Attachment:
                // 微信返回的xml中有很多<br/>, 所以要先去掉
                let xmlText = decode(msg.text().replace(new RegExp("<br/>", "g"), ""));
                let xmlObj = parser.parse(xmlText);

                try {
                    let url: string;
                    url = xmlObj.msg.appmsg.url;
                    let archiveURL = await send2Archive(url);
                    if (archiveURL) {
                        await msg.say(archiveURL);
                    }
                } catch (e: any) {
                    log.error(logPrefix, e);
                    msg.say(e.message);
                }
                break;

            // 消息为普通文本, 从普通文本中提取url
            case bot.Message.Type.Text:
                //去掉所有的html标记
                let plainText = msg.text().replace(/<[^>]+>/g, " ");
                // 数组去重
                let urls = new Set(plainText.match(urlRegexSafe()));
                urls.forEach(async (url) => {
                    let uriObj = URI.parse(url);
                    // 排除了已经有协议头和"//"开头的情况
                    if (!uriObj.scheme && !url.startsWith("//")) {
                        url = "http://" + url;
                    }
                    try {
                        let archiveURL = await send2Archive(url);
                        if (archiveURL) {
                            await msg.say(archiveURL);
                        }
                    } catch (e: any) {
                        log.error(logPrefix, e);
                        msg.say(e.message);
                    }
                });
                break;

            case bot.Message.Type.Video:
                break;

            // 希望用deepdanbooru识别图片内容
            case bot.Message.Type.Image:
                let imgBox = await msg.toFileBox();
                let img = await imgBox.toStream();
                let formdata = new FormData();
                formdata.append("img", img);
                axios
                    .post(config.animepic.url, formdata)
                    .then((res) => {
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
                        let imgInfo = `安全系数: ${Object.keys(res.data.system)[0].substring(7)}\n角色: ${characters}\n标签: ${tags}`;
                        msg.say(imgInfo);
                    })
                    .catch((e) => {
                        log.error(logPrefix, e);
                        msg.say(e.message);
                    });
                break;
        }
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
                if (friendship.hello() === "moechika") {
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
bot.on("logout", onLogout);
bot.on("message", onMessage);
// Friendship Event will emit when got a new friend request, or friendship is confirmed.

bot.on("friendship", onFriendship);

bot.start()
    .then(() => log.info("StarterBot", "Starter Bot Started."))
    .catch((e) => log.error("StarterBot", e));
