// HTMLRewriter 资源路径重写器
// 将 <img src="/foo.png">、<script src="foo.js">、<link href="/bar.css"> 等相对路径重写为 Worker 代理绝对路径
// 只处理 src/href 属性，且仅当其为相对路径时

export class ResourceUrlRewriter {
  baseUrl: string;
  sid: string;
  workerBase: string;
  constructor(baseUrl: string, sid: string, workerBase: string) {
    this.baseUrl = baseUrl;
    this.sid = sid;
    this.workerBase = workerBase;
  }

  rewriteUrl(attrValue: string): string {
    // 绝对 URL 或 data: 不处理
    if (/^(https?:)?\/\//i.test(attrValue) || attrValue.startsWith('data:')) return attrValue;
    // 绝对路径（/开头）
    let absUrl: string;
    if (attrValue.startsWith('/')) {
      const u = new URL(this.baseUrl);
      absUrl = u.origin + attrValue;
    } else {
      // 相对路径
      absUrl = new URL(attrValue, this.baseUrl).href;
    }
    // 转为 base64url
    const b64 = btoa(absUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${this.workerBase}/p?sid=${this.sid}&u=${b64}`;
  }

  elementHandler(attr: string) {
    const self = this;
    return {
      element(el: Element) {
        const v = el.getAttribute(attr);
        if (!v) return;
        const newUrl = self.rewriteUrl(v);
        if (newUrl !== v) el.setAttribute(attr, newUrl);
      }
    };
  }
}
