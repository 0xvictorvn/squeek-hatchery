import {createServer} from 'vite';
const server=await createServer({configFile:false,root:process.cwd(),base:'./',server:{host:'127.0.0.1',port:5173,strictPort:true,fs:{allow:[process.cwd()]}},optimizeDeps:{noDiscovery:true,include:[]}});await server.listen();server.printUrls();
