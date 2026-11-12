import {listen}from '../src/http.mjs';
export function saved(kind='normal'){const parts=[
'Content-Type: image/png\r\nContent-ID: <logo>\r\nContent-Location: https://exhibit.test/img/logo.png\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=',
'Content-Type: text/html; charset=utf-8\r\nContent-ID: <root>\r\nContent-Location: https://exhibit.test/a/index.html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<html><head><base href="../b/"></head><body>=E8=B5=84=E6=96=99<img src="cid:logo"><iframe src="child.html"></iframe><img src="missing.png"></body></html>',
'Content-Type: text/html; charset=utf-8\r\nContent-Location: https://exhibit.test/b/child.html\r\n\r\n<p>child<img src="logo.png"></p>',
'Content-Type: image/png\r\nContent-Location: https://exhibit.test/b/logo.png\r\n\r\nfirst',
'Content-Type: image/png\r\nContent-Location: https://exhibit.test/b/logo.png\r\n\r\nsecond'];
let result='MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="web-boundary"; start="<root>"; type="text/html"\r\n\r\n'+parts.map(part=>'--web-boundary\r\n'+part+'\r\n').join('')+'--web-boundary--\r\n';if(kind==='truncated')result=result.slice(0,-30);return Buffer.from(result);}
export async function startFixture(){return listen(async url=>url.pathname==='/saved.mhtml'?{type:'multipart/related',body:saved(url.searchParams.get('kind'))}:{status:404,body:{}});}
