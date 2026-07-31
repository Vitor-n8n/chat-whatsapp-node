# Usa uma imagem oficial e leve do Node.js
FROM node:18-alpine

# Cria a pasta de trabalho dentro do container
WORKDIR /usr/src/app

# Copia os arquivos de configuração de dependências
COPY package*.json ./

# Instala apenas as bibliotecas necessárias
RUN npm install --production

# Copia o restante dos arquivos do projeto (server.js, pasta public, etc.)
COPY . .

# Expõe a porta 3000 que o nosso Express usa
EXPOSE 3002

# Comando para iniciar a aplicação quando o container subir
CMD ["node", "server.js"]