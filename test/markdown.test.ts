import { assert } from "chai";
import { estimateTokens, escapeHtml, renderMarkdown, sanitizeHtml } from "../src/modules/markdown";

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
    // "中文测试" = 4 CJK chars -> 4 tokens
    assert.equal(estimateTokens("中文测试"), 4);
  });
});