FROM node:lts-bookworm-slim

# install chrome and chromedriver
# WORKDIR /
# RUN apt update && apt install -y git unzip wget && \
#     wget -O chromedriver_linux64.zip http://chromedriver.storage.googleapis.com/114.0.5735.90/chromedriver_linux64.zip && \
#     unzip chromedriver_linux64.zip && \
#     mv chromedriver /usr/bin/chromedriver && chmod +x /usr/bin/chromedriver && rm chromedriver_linux64.zip && \
#     wget -O google-chrome-stable_amd64.deb https://mirror.cs.uchicago.edu/google-chrome/pool/main/g/google-chrome-stable/google-chrome-stable_114.0.5735.90-1_amd64.deb && \
#     apt install ./google-chrome-stable_amd64.deb -y && \
#     rm google-chrome-stable_amd64.deb && \
#     apt autoremove -y && apt clean

# # install archivebox-python
# RUN apt update && apt install -y virtualenv && \
#     cd / && git clone https://github.com/darknightlab/archivebox-python && \
#     mkdir env && cd env && virtualenv -p python3 archivebox-python && \
#     cd / && . env/archivebox-python/bin/activate && \
#     cd /archivebox-python && pip install --no-cache-dir -r requirements.txt

# install wechat-bot
WORKDIR /wechat-bot
COPY . .
RUN cd /wechat-bot && npm install && \
    # fonts-liberation libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils && \
    apt update && apt install -y ca-certificates && \
    apt autoremove -y && apt clean

# touch memory-card.json
WORKDIR /wechat-bot
RUN mkdir config && touch config/wechat-bot.memory-card.json && \
    ln -s /wechat-bot/config/wechat-bot.memory-card.json wechat-bot.memory-card.json

CMD [ "npm", "start" ]
