FROM node:20-slim

# Python 설치
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv

WORKDIR /app

# 패키지 파일 복사
COPY package*.json ./
COPY requirements.txt ./

# Node.js 패키지 설치
RUN npm install

# Python 패키지 설치
RUN pip3 install --break-system-packages -r requirements.txt

# 소스 코드 복사
COPY . .

# 포트 설정
EXPOSE 3000

# 서버 시작
CMD ["node", "server.js"]
