import os
from revChatGPT.revChatGPT import Chatbot

username = os.getenv("CHATGPT_USERNAME")
password = os.getenv("CHATGPT_PASSWORD")

config = {
    "proxy": os.getenv("HTTPS_PROXY"),
}
chatbot = Chatbot(config, captcha_solver=None)
try:
    chatbot.login(username, password)
    print(chatbot.config.get("session_token"))
except Exception as e:
    print("Error: ", e)
