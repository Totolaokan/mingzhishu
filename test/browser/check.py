"""浏览器端验证（Playwright + Chrome）。运行：python3 test/browser/check.py
需要先由本脚本自动启动 serve-with-mocks.js（模拟上游）。截图输出到 test/browser/shots/。"""
import json, os, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHOTS = ROOT / "test" / "browser" / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")

JOB = "我很想辞职去做自己喜欢的事，可是每个月还有一万二的房贷，家里人也指望着我，我觉得自己既不敢走，也不甘心留。"
results = []

def check(name, cond):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name, flush=True)

proc = subprocess.Popen(["node", "test/browser/serve-with-mocks.js"], cwd=ROOT,
                        stdout=subprocess.PIPE, stdin=subprocess.PIPE, text=True)
info = json.loads(proc.stdout.readline())
CONF, UNCONF = info["configured"], info["unconfigured"]

def reveal_requests(page):
    reqs = []
    page.on("request", lambda r: reqs.append(r) if r.url.endswith("/api/reveal") else None)
    return reqs

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, args=[
            "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])

        # —— 1. 未配置状态 ——
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN")
        page = ctx.new_page()
        page.goto(UNCONF)
        expect(page.locator("#statusNotice")).to_be_visible()
        check("未配置：页面明示模型尚未接入", "模型尚未接入" in page.locator("#statusNotice").inner_text())
        check("未配置：语音按钮禁用并说明原因", page.locator("#voiceStart").is_disabled()
              and "尚未接入" in page.locator("#voiceUnavailable").inner_text())
        time.sleep(1.0)
        page.screenshot(path=SHOTS / "01-unconfigured.png", full_page=True)
        page.fill("#text", JOB)
        page.click("#open")
        expect(page.locator("#failure")).to_be_visible()
        check("未配置：开启后显示诚实失败，不给句子", "模型尚未接入" in page.locator("#failTitle").inner_text()
              and page.locator("#retry").is_hidden())
        page.screenshot(path=SHOTS / "02-unconfigured-fail.png", full_page=True)

        # 未配置 + 危机表达 → 仍有安全支持
        page.click("#back")
        page.fill("#text", "我真的撑不下去了，不想活了。")
        page.click("#open")
        expect(page.locator("#safety")).to_be_visible()
        check("未配置 + 危机：显示安全信息，并标注非模型生成",
              "12356" in page.locator("#safety").inner_text()
              and "不是模型生成" in page.locator("#safetyOrigin").inner_text())
        page.screenshot(path=SHOTS / "03-unconfigured-crisis.png", full_page=True)
        ctx.close()

        # —— 2. 已配置（模拟上游）：输入 → 等待 → 揭晓；防重复提交；键盘 ——
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN")
        page = ctx.new_page()
        reqs = reveal_requests(page)
        page.goto(CONF)
        page.wait_for_function("document.querySelector('#statusNotice').hidden === true")
        check("发送前可见说明：交给哪个服务、不承诺绝对私密",
              "测试用模拟模型" in page.locator("#sendNote").inner_text()
              and "无法承诺绝对私密" in page.locator("#sendNote").inner_text())
        time.sleep(1.0)
        page.screenshot(path=SHOTS / "04-compose-desktop.png", full_page=True)
        page.fill("#text", JOB)
        page.evaluate("const b=document.getElementById('open'); b.click(); b.click(); b.click();")
        page.focus("#text"); page.keyboard.press("Control+Enter")
        expect(page.locator("#waiting")).to_be_visible()
        page.screenshot(path=SHOTS / "05-waiting.png", full_page=True)
        expect(page.locator("#reveal")).to_be_visible(timeout=8000)
        time.sleep(2.4)
        page.screenshot(path=SHOTS / "06-reveal-desktop.png", full_page=True)
        sentence = page.locator("#sentence").inner_text()
        check("揭晓：只呈现一句话", sentence.startswith("不敢走是因为") and "\n" not in sentence)
        check("揭晓：普通结果不显示安全栏、无标题", page.locator("#safety").is_hidden()
              and page.locator("#reveal h1, #reveal h2, #reveal h3").count() == 0)
        check("防重复提交：多次点击/快捷键只发出 1 个请求", len(reqs) == 1)
        check("揭晓：焦点移到句子上", page.evaluate("document.activeElement.id") == "sentence")
        page.keyboard.press("Escape")
        check("键盘：Esc 回到书写处且文字保留", page.locator("#compose").is_visible()
              and page.input_value("#text") == JOB)

        # 超时 → 手动重试
        page.fill("#text", "测试超时：我在等一个结果")
        page.keyboard.press("Control+Enter")
        expect(page.locator("#failure")).to_be_visible(timeout=10000)
        check("超时：显示等太久并提供重试", "等得太久" in page.locator("#failTitle").inner_text()
              and page.locator("#retry").is_visible())
        page.screenshot(path=SHOTS / "07-timeout.png", full_page=True)
        page.click("#retry")
        expect(page.locator("#reveal")).to_be_visible(timeout=10000)
        check("超时后手动重试成功", "再试一次" in page.locator("#sentence").inner_text())

        # 多段输出 → 诚实失败
        page.click("#again")
        page.fill("#text", "测试多段：我不知道怎么办")
        page.click("#open")
        expect(page.locator("#failure")).to_be_visible(timeout=10000)
        check("多段输出：两次不合格后诚实提示", "没能写出合适的话" in page.locator("#failTitle").inner_text())
        page.screenshot(path=SHOTS / "08-rejected.png", full_page=True)

        # 危机（模型已配置）
        page.click("#back")
        page.fill("#text", "我真的撑不下去了，这几天一直在想，不想活了。")
        page.click("#open")
        expect(page.locator("#safety")).to_be_visible(timeout=10000)
        time.sleep(2.4)
        check("危机：模型的安全回应 + 固定安全信息", "12356" in page.locator("#safety").inner_text()
              and "谢谢你愿意说出来" in page.locator("#sentence").inner_text()
              and "由模型生成" in page.locator("#safetyOrigin").inner_text())
        page.screenshot(path=SHOTS / "09-crisis.png", full_page=True)

        # 客户端超时（服务端无响应）
        ctx2_cfg = page.evaluate("fetch('/api/config').then(r=>r.json())")
        ctx.close()

        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN")
        page = ctx.new_page()
        def short_cfg(route):
            cfg = dict(ctx2_cfg); cfg["clientTimeoutMs"] = 1200
            route.fulfill(status=200, content_type="application/json", body=json.dumps(cfg))
        page.route("**/api/config", short_cfg)
        page.route("**/api/reveal", lambda route: None)
        page.goto(CONF)
        page.wait_for_function("document.querySelector('#statusNotice').hidden === true")
        page.fill("#text", JOB)
        page.click("#open")
        expect(page.locator("#failure")).to_be_visible(timeout=5000)
        check("客户端超时：服务端无回应时也能退出等待并可重试",
              "等得太久" in page.locator("#failTitle").inner_text() and page.locator("#retry").is_enabled())
        ctx.close()

        # —— 3. 语音：成功路径（假麦克风 + 模拟转写） ——
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN",
                                  permissions=["microphone"])
        page = ctx.new_page()
        reqs = reveal_requests(page)
        page.goto(CONF)
        expect(page.locator("#voiceStart")).to_be_enabled()
        page.click("#voiceStart")
        expect(page.locator("#voiceConsent")).to_be_visible()
        check("语音：录音前先说明处理方式", "上传到本站服务器" in page.locator("#voiceDisclosure").inner_text()
              and "测试用模拟转写" in page.locator("#voiceDisclosure").inner_text())
        page.screenshot(path=SHOTS / "10-voice-consent.png", full_page=True)
        page.click("#voiceConfirm")
        expect(page.locator("#voiceRecording")).to_be_visible()
        check("语音：录音中禁用开启", page.locator("#open").is_disabled())
        time.sleep(1.6)
        page.screenshot(path=SHOTS / "11-recording.png", full_page=True)
        page.click("#voiceStop")
        expect(page.locator("#transcriptNote")).to_be_visible(timeout=8000)
        check("语音：转写文本进入可编辑书写框，并提示核对",
              page.input_value("#text") == "最近很累，不知道还要撑多久" and page.locator("#text").is_editable())
        check("语音：转写后不会自动生成", len(reqs) == 0)
        page.fill("#text", page.input_value("#text") + "（已修改）")
        page.screenshot(path=SHOTS / "12-transcribed.png", full_page=True)
        ctx.close()

        # —— 4. 语音：权限被拒 ——
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN")
        ctx.add_init_script("""
          navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
        """)
        page = ctx.new_page()
        page.goto(CONF)
        page.click("#voiceStart"); page.click("#voiceConfirm")
        expect(page.locator("#voiceError")).to_be_visible()
        check("语音：权限被拒时说明并引导文字输入",
              "没有得到麦克风权限" in page.locator("#voiceError").inner_text()
              and page.input_value("#text") == "" and page.locator("#text").is_editable())
        page.screenshot(path=SHOTS / "13-voice-denied.png", full_page=True)
        ctx.close()

        # —— 5. 语音：浏览器不支持 ——
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN")
        ctx.add_init_script("delete window.MediaRecorder;")
        page = ctx.new_page()
        page.goto(CONF)
        page.wait_for_function("document.querySelector('#voiceUnavailable').hidden === false")
        check("语音：不支持录音时禁用并说明", page.locator("#voiceStart").is_disabled()
              and "不支持录音" in page.locator("#voiceUnavailable").inner_text())
        ctx.close()

        # —— 6. 语音：转写服务失败 ——
        ctx = browser.new_context(viewport={"width": 1280, "height": 860}, locale="zh-CN", permissions=["microphone"])
        page = ctx.new_page()
        page.route("**/api/transcribe", lambda r: r.fulfill(status=502, content_type="application/json",
                                                             body='{"error":"UPSTREAM_ERROR"}'))
        page.goto(CONF)
        page.click("#voiceStart"); page.click("#voiceConfirm")
        time.sleep(1.2)
        page.click("#voiceStop")
        expect(page.locator("#voiceError")).to_be_visible(timeout=5000)
        check("语音：转写失败时不伪造文字", page.input_value("#text") == ""
              and "转写失败" in page.locator("#voiceError").inner_text())
        ctx.close()

        # —— 7. 手机尺寸 + 减少动效 ——
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True, locale="zh-CN", reduced_motion="reduce")
        page = ctx.new_page()
        page.goto(CONF)
        check("减少动效：跟随系统设置", page.get_attribute("#motionToggle", "aria-pressed") == "true")
        page.wait_for_function("document.querySelector('#statusNotice').hidden === true")
        page.fill("#text", "最近很累")
        page.screenshot(path=SHOTS / "14-compose-mobile.png", full_page=True)
        no_overflow = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        check("手机：无横向溢出", no_overflow)
        page.fill("#text", "最近很累")
        page.click("#open")
        expect(page.locator("#reveal")).to_be_visible(timeout=8000)
        anim = page.evaluate("getComputedStyle(document.querySelector('#sentence')).animationName")
        check("减少动效：揭晓不播放动画", anim == "none")
        page.screenshot(path=SHOTS / "15-reveal-mobile.png", full_page=True)
        ctx.close()

        browser.close()
finally:
    proc.terminate()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
