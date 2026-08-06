import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("服务端渲染闪充站运营模拟器", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /兆瓦闪充站运营模拟器/);
  assert.match(html, />A<\/span><strong>通用枪/);
  assert.match(html, />B<\/span><strong>闪充专用枪/);
  assert.match(html, /2100/);
  assert.match(html, /站点实时曲线/);
  assert.match(html, /闪充站储能电量/);
  assert.match(html, /车位换车周转/);
  assert.match(html, /预计剩余/);
  assert.match(html, /aria-label="调整趋势采样间隔"/);
  assert.match(html, /模拟断电/);
  assert.match(html, /启用临时限功率/);
  assert.match(html, /手动调整当前电量/);
  assert.match(html, /最大可接受等待时间/);
  assert.match(html, /无限等待/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});
