import { assert } from "chai";
import { appendMarkdown, escapeHtml, estimateTokens, renderMarkdown, sanitizeHtml } from "../src/modules/markdown";

describe("markdown rendering", function () {
  it("renders markdown to sanitized HTML", function () {
    const html = renderMarkdown("**bold** and `code` and [link](https://example.test)");
    assert.include(html, "<strong>bold</strong>");
    assert.include(html, "<code>code</code>");
    assert.include(html, 'href="https://example.test"');
  });

  it("escapes raw HTML and strips dangerous attributes/URLs", function () {
    // html:false -> raw HTML is escaped, never injected
    assert.notInclude(renderMarkdown("<script>alert(1)</script>"), "<script>");
    assert.include(renderMarkdown("<script>alert(1)</script>"), "&lt;script&gt;");
    // javascript:/data: links are stripped by the sanitizer
    const evil = sanitizeHtml('<a href="javascript:alert(1)" onclick="x()">x</a>');
    assert.notInclude(evil, "javascript:");
    assert.notInclude(evil, "onclick");
    assert.include(evil, ">x</a>");
  });

  it("breaks newlines into <br>", function () {
    assert.include(renderMarkdown("line one\nline two"), "<br>");
  });

  it("escapes plain text on render failure path", function () {
    assert.equal(escapeHtml("<b>&"), "&lt;b&gt;&amp;");
  });

  it("estimates tokens (latin chars/4, CJK ~1)", function () {
    assert.equal(estimateTokens(""), 0);
    assert.ok(estimateTokens("hello world this is a test") > 0);
    assert.equal(estimateTokens("中文测试"), 4);
  });

  it("appendMarkdown injects rendered nodes into the Zotero document", function () {
    const wdoc = (Zotero as any).getMainWindow().document as Document;
    const el = wdoc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wdoc.documentElement.appendChild(el);
    try {
      appendMarkdown(el, "**Bold** and `code`", wdoc);
      assert.equal(el.querySelector("strong")?.textContent, "Bold", "strong present");
      assert.equal(el.querySelector("code")?.textContent, "code", "code present");
      assert.equal(el.querySelector("em"), null, "no stray emphasis");
    } finally {
      el.remove();
    }
  });

  it("appendMarkdown works without the Node global (addon sandbox parity)", function () {
    const w = (Zotero as any).getMainWindow();
    const wdoc = w.document as Document;
    const el = wdoc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wdoc.documentElement.appendChild(el);
    const savedNode = (w as any).Node;
    try {
      // The addon bootstrap sandbox may not expose `Node`; rendering must not
      // depend on it (use numeric nodeType constants instead).
      (w as any).Node = undefined;
      appendMarkdown(el, "**Bold** reply\nwith `code`", wdoc);
      assert.equal(el.querySelector("strong")?.textContent, "Bold", "strong rendered without Node global");
      assert.ok(el.querySelector("br"), "br rendered without Node global");
    } finally {
      (w as any).Node = savedNode;
      el.remove();
    }
  });
});