import fs from "fs";
import OpenAI from "openai";
import * as crypto from "crypto";
import HttpsProxyAgent from 'https-proxy-agent'

type ConversationOptions = {
    chatllm: {
        enable: boolean;
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

type ConversationType = "contact" | "room";

// 聊天软件中的对话
type Conversation = {
    ID: string;
    name: string;
    sessionID: string; // 大模型相关的唯一ID，目前还没什么用
    type: ConversationType;
    options: ConversationOptions;
    // 大模型格式的对话消息list
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
};

// 聊天软件的原始消息，接收和准备发送时使用该格式
type OriginalMessage = {
    conversation: Conversation;
    senderName: string;
    type: string;
    mentionSelf: boolean;
    time: Date;
    content: any;
};

// 把对话发给MainModel前的检查结果
type JudgeResult = {
    send: boolean;
    voice: boolean;
}

function isJudgeResult(obj: any): obj is JudgeResult {
    try {
        return typeof obj.send == "boolean" && typeof obj.voice == "boolean";
    } catch (e) {
        return false;
    }
}

class ChatBot {

    constructor(config: any) {
        this.config = config;
        this.name= config.wechat.botaccount;
        this.DefaultConversationOptions.chatllm.enable = config.chatbot.chatllm.enable;
        this.DefaultConversationOptions.archivebox.enable = config.chatbot.archivebox.enable;
        this.DefaultConversationOptions.animepic.enable = config.chatbot.animepic.enable;
        this.smallModel= new OpenAI({
            baseURL: config.chatbot.chatllm.smallModel.baseURL,
            apiKey: config.chatbot.chatllm.smallModel.apiKey,
            timeout: config.chatbot.chatllm.smallModel.timeout,
        });
        this.mainModel= new OpenAI({
            baseURL: config.chatbot.chatllm.mainModel.baseURL,
            apiKey: config.chatbot.chatllm.mainModel.apiKey,
            timeout: config.chatbot.chatllm.mainModel.timeout,
        });
    }

    public name: string = "";

    private config: any;

    private DefaultConversationOptions: ConversationOptions = {
        chatllm: {
            enable: false,
            replyEveryoneInRoom: false,
            customRoleToContact: false,
        },
        archivebox: {
            enable: false,
        },
        animepic: {
            enable: false,
        },
    };

    private Conversations: Map<string, Conversation> = new Map();

    private Command = new Map<string, (args: string[], conversation: Conversation) => string | undefined>([
        ["chatllm", this.cmd_chatllm],
        // ["archive", cmd_archive],
        // ["animepic", cmd_animepic],
        // ["test", cmd_test],
    ]);

    private smallModel : OpenAI;
    public smallModelInstructions: string = `之前的对话是你和其他人的聊天内容，你的ID是${this.name}。你的任务是查看之前的所有对话，并给我一个json。json的格式必须为： {send: boolean,voice: boolean}。如果你觉得你应该继续回消息，则send为true，否则为false；如果你希望发送语音消息，则voice为true。`;

    private mainModel: OpenAI;
    public mainModelInstructionsPrefix:string =`
你处在一个群聊中，和许多人聊天。你的ID是${this.name}。聊天的消息用json格式表示，包含了发送者，发送时间，消息内容，形式为：{"sender":xxx, "time": "xxx", "content": "消息内容"}
你只需要回复普通格式的消息，我会用程序帮你转换成正确格式。`;

    // 检测消息是否包含命令
    cmdInMessage(originalMessage: OriginalMessage): OriginalMessage[] {
        let isAboutMe = originalMessage.conversation.type == "contact" || (originalMessage.conversation.type == "room" && originalMessage.mentionSelf);
        if (originalMessage.type == "text" && isAboutMe) {
            let textList = originalMessage.content.trim().split(" ");
            if (textList[0].startsWith("/")) {
                // 含有命令
                let cmd = textList[0].slice(1);
                if (this.Command.has(cmd)) {
                    try {
                        this.Command.get(cmd)!(textList.slice(1), originalMessage.conversation);
                    } catch (e: any) {
                        return [{
                            conversation: originalMessage.conversation,
                            senderName: this.name,
                            type: "text",
                            mentionSelf: false,
                            time: new Date(),
                            content: e.message as string,
                        }];
                       
                    }
                } else {
                    return [{
                        conversation: originalMessage.conversation,
                        senderName: this.name,
                        type: "text",
                        mentionSelf: false,
                        time: new Date(),
                        content: `未知命令: /${cmd}`,
                    }];
                }
                return [{
                    conversation: originalMessage.conversation,
                    senderName: this.name,
                    type: "text",
                    mentionSelf: false,
                    time: new Date(),
                    content: `设置成功: /${cmd}`,
                }];
            }
            return [];
        } else {
            return [];
        }
    }

    cmd_chatllm(args: string[], conversation: Conversation) {
        let clear = () => {
            conversation.messages = [this.newEmptyMessage(conversation.type)];
            return "已清空聊天记录";
        };
        if (args.length > 0) {
            switch (args[0]) {
                case "clear":
                    return clear();
                case "disable":
                    if (args.length == 1) {
                        conversation.options.chatllm.enable = false;
                    } else if (args.length == 2) {
                        if (args[1] == "replyEveryoneInRoom") {
                            conversation.options.chatllm.replyEveryoneInRoom = false;
                            return "已关闭在群里回复所有人";
                        } else if (args[1] == "customRoleToContact") {
                            conversation.options.chatllm.customRoleToContact = false;
                            clear();
                            return "已关闭自定义角色"; // 下次这个选项不要了
                        }
                    }
                    break;

                case "enable":
                    if (args.length == 1) {
                        conversation.options.chatllm.enable = true;
                    } else if (args.length == 2) {
                        if (args[1] == "replyEveryoneInRoom") {
                            conversation.options.chatllm.replyEveryoneInRoom = true;
                            return "已开启在群里回复所有人";
                        } else if (args[1] == "customRoleToContact") {
                            conversation.options.chatllm.customRoleToContact = true;
                            clear();
                            return "已开启自定义角色";
                        }
                    }
                    break;

                default:
                    // 命令错误
                    return "/chatgpt [clear|recover|save|enable|disable]";
            }
        } else {
            return "/chatgpt [clear|recover|save|enable|disable]";
        }
    }

    

    newEmptyMessage(conversationType: string): OpenAI.Chat.Completions.ChatCompletionMessageParam {
        switch (conversationType) {
            case "contact":
                return { role: "system", content: [{ type: "text", text: this.config.chatbot.chatllm.contactRole as string }] };
            case "room":
                return { role: "system", content: [{ type: "text", text: this.mainModelInstructionsPrefix+(this.config.chatbot.chatllm.roomRole as string) }] };
            default:
                return { role: "system", content: "不会有这种情况" };
        }
    }

    getConversation(conversationID: string, conversationName: string, conversationType: ConversationType) {
        if (this.Conversations.has(conversationID) && this.Conversations.get(conversationID)!.type == conversationType) {
            this.Conversations.get(conversationID)!.name = conversationName;
            return this.Conversations.get(conversationID)!;
        } else {
            return this.newConversation(conversationID, conversationName, conversationType);
        }
    }

    newConversation(conversationID: string, conversationName: string, conversationType: ConversationType): Conversation {
        return {
            ID: conversationID,
            name: conversationName,
            type: conversationType,
            sessionID: crypto.randomUUID(),
            options: this.DefaultConversationOptions,
            messages: [this.newEmptyMessage(conversationType)],
        };
    }

    dumpConversation(dumpPrefix: string) {
        fs.writeFileSync(`${dumpPrefix}conversation.chatbot.json`, JSON.stringify([...this.Conversations.values()]));
    }

    async loadConversation(dumpPrefix: string, getNewConversation: (c: Conversation) => Promise<Conversation | undefined>) {
        let clist: Conversation[] = JSON.parse(fs.readFileSync(`${dumpPrefix}conversation.chatbot.json`, "utf8"));
        for (let c of clist) {
            let newConversation = await getNewConversation(c);
            if (newConversation) {
                this.Conversations.set(newConversation.ID, newConversation);
            }
        }
    }

    async sendToMainModel(conversation: Conversation) {
        let response = await this.mainModel.chat.completions.create({
            model: this.config.chatbot.chatllm.mainModel.name,
            messages: conversation.messages,
        },this.config.chatbot.chatllm.mainModel.proxy?{
            httpAgent: HttpsProxyAgent('http://proxy-host:proxy-port'),
        }:undefined);
        conversation.messages.push(response.choices[0].message);
        return response.choices[0].message.content;
    }

    async shouldReply(originalMessage: OriginalMessage): Promise<JudgeResult> {
        switch (originalMessage.conversation.type) {
            case "contact":
                switch (originalMessage.type) {
                    case "text":
                        if (originalMessage.conversation.options.chatllm.enable) {
                            originalMessage.conversation.messages.push({ role: "user", content: [{ type: "text", text: originalMessage.content }] });
                            return await this.shouldReplyBySmallModel(originalMessage.conversation);
                        }
                        break;
                    default:
                        return { send: false, voice: false };
                }
                break;
            case "room":
                switch (originalMessage.type) {
                    case "text":
                        if (originalMessage.conversation.options.chatllm.enable) {
                            originalMessage.conversation.messages.push({ role: "user", content: [{ type: "text", text: JSON.stringify({sender: originalMessage.senderName, time: originalMessage.time.toLocaleString(), content: originalMessage.content }) }] });
                            return await this.shouldReplyBySmallModel(originalMessage.conversation);
                        }
                        break;
                    default:
                        return { send: false, voice: false };
                }
                break;
            default:
                return { send: false, voice: false };
        }
        return { send: false, voice: false };
    }

    static removeThink(t:string|null):string{
        if (t) {
            return t.replace(/<think>.*?<\/think>/g, "").trim();
        } else {
            return "";
        }
    }

    async shouldReplyBySmallModel(conversation: Conversation): Promise<JudgeResult> {
        let m=structuredClone(conversation.messages);
        m[0].content=[{type:"text",text:this.smallModelInstructions}];
        let result = await this.smallModel.chat.completions.create({
            model: this.config.chatbot.chatllm.smallModel.name,
            messages: m,
        },this.config.chatbot.chatllm.smallModel.proxy?{
            httpAgent: HttpsProxyAgent('http://proxy-host:proxy-port'),
        }:undefined)
        let finalResult=JSON.parse(ChatBot.removeThink(result.choices[0].message.content));
        if (isJudgeResult(finalResult)) {
            return finalResult;
        } else {
            return { send: false, voice: false };
        }
    }

    async thinkByLLM(originalMessage: OriginalMessage) : Promise<OriginalMessage[]> {
        let q:OriginalMessage[] = [];
        let sr=await this.shouldReply(originalMessage);
        if (sr.send) {
            let response = await this.sendToMainModel(originalMessage.conversation);
            q.push({
                conversation: originalMessage.conversation,
                senderName: this.name,
                type: "text",
                mentionSelf: false,
                time: new Date(),
                content: response,
            });
        }
        return q;
    }

    async receiveMessage(originalMessage: OriginalMessage) {
        let responseQueue: OriginalMessage[] = [];
        responseQueue.concat(this.cmdInMessage(originalMessage));
        // 循环运行thinkByLLM，直到其返回的数组为空
        let q = await this.thinkByLLM(originalMessage);
        while (q.length > 0) {
            responseQueue = responseQueue.concat(q);
            q = await this.thinkByLLM(originalMessage);
        }
        
        return responseQueue;  
    }
}

export { ChatBot, OriginalMessage, Conversation, ConversationOptions, JudgeResult, ConversationType };