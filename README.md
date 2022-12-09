# wechat-bot

a wechat bot using wechaty, which can archive web pages, analyze pictures, and automatically reply.

## Dependencies

-   [wechaty](https://github.com/wechaty/wechaty)
-   [DeepDanbooru](https://github.com/KichangKim/DeepDanbooru)
-   [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox)
-   [chatgpt-api](https://github.com/transitive-bullshit/chatgpt-api)

## Features

-   Automatically save links contained in messages to [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox)
-   Using [DeepDanbooru](https://github.com/KichangKim/DeepDanbooru) to analyze anime girls in pictures
-   Using [chatgpt-api](https://github.com/transitive-bullshit/chatgpt-api) to automatically reply (supports continuous conversations)

## Deploy

### Dependencies

Deploy [archivebox](https://github.com/ArchiveBox/ArchiveBox) or set `archive.enable = false` in config.yaml

Deploy [deepdanbooru-docker with web api](https://github.com/darknightlab/DeepDanbooru-Docker) or set `animepic.enable = false` in config.yaml

### Docker Compose

Deploy [wechat-bot](./)

```bash
wget https://raw.githubusercontent.com/darknightlab/wechat-bot/main/docker-compose.yml
mkdir config
wget -O config/config.yaml https://raw.githubusercontent.com/darknightlab/wechat-bot/main/config/config.example.yaml
vim config/config.yaml
docker-compose up -d
```

### Bash

```bash
git clone https://github.com/darknightlab/wechat-bot.git
cd wechat-bot
npm install
cp config/config.example.yaml config/config.yaml
vim config/config.yaml
npm start
```

## Usage

### Commands

```telegram
/chatgpt [enable|disable|reset|refresh]
/archive [enable|disable]
/animepic [enable|disable]
```

### ChatGPT

send message to bot, it will automatically reply.

![](./docs/assets/chatgpt%20screenshot.png)

### ArchiveBox

send links or forward Wechat Articles to bot, it will save to ArchiveBox.

![](./docs/assets/archivebox%20screenshot.png)

### DeepDanbooru

send anime pictures to bot, it will reply tags.

![](./docs/assets/deepdanbooru%20screenshot.png)
