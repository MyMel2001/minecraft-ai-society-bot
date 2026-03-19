#!/bin/bash
cd "$(dirname "$0")"
git pull
npm i
node index.js >mc-bot.log 2>&1 &
