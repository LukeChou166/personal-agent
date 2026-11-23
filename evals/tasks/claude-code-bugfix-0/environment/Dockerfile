# 评测 claude-code 的任务环境：
# - Bun：运行本项目（reverse-engineered）claude-code CLI
# - Python3：运行 verifier 测试
FROM oven/bun:1

RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY buggy.py /app/buggy.py
