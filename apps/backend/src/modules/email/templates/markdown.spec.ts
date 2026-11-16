import { escapeHtml } from './escape';
import { renderMarkdownHtml, renderMarkdownText } from './markdown';

const S = { p: '__P__', list: '__L__', li: '__LI__', a: '__A__' };
const md = (src: string, values: Record<string, string>) =>
  renderMarkdownHtml(src, values, S);

describe('escapeHtml', () => {
  it('escapes HTML metacharacters and template braces', () => {
    expect(escapeHtml(`<a href="x">'&'</a>{{y}}`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;&#123;&#123;y&#125;&#125;',
    );
  });
});

describe('renderMarkdownHtml (safe subset)', () => {
  const v = {
    'customer.name': 'Asha',
    'reset.url': 'https://x.test/r?a=1&b=2',
  };

  it('renders paragraphs, line breaks, bold and italic', () => {
    expect(md('Hi **there**\nand *you*\n\n_second_', {})).toBe(
      '<p style="__P__">Hi <strong>there</strong><br>and <em>you</em></p>' +
        '<p style="__P__"><em>second</em></p>',
    );
  });

  it('renders bullet and numbered lists', () => {
    expect(md('- one\n- **two**', {})).toBe(
      '<ul style="__L__"><li style="__LI__">one</li><li style="__LI__"><strong>two</strong></li></ul>',
    );
    expect(md('1. a\n2. b', {})).toBe(
      '<ol style="__L__"><li style="__LI__">a</li><li style="__LI__">b</li></ol>',
    );
  });

  it('renders http(s) and mailto links, escaping the href', () => {
    expect(md('[Reset]({{reset.url}})', v)).toBe(
      '<p style="__P__"><a href="https://x.test/r?a=1&amp;b=2" style="__A__">Reset</a></p>',
    );
    expect(md('[Mail](mailto:a@b.co)', {})).toContain(
      '<a href="mailto:a@b.co"',
    );
  });

  it('drops links with other schemes but keeps their text', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '//evil.test',
      'JaVaScRiPt:alert(1)',
    ]) {
      const html = md(`[click](${url})`, {});
      expect(html).not.toContain('<a');
      expect(html).toContain('click');
    }
  });

  it('drops a link whose placeholder value is unsafe', () => {
    const html = md('[go]({{reset.url}})', {
      'reset.url': 'javascript:alert(1)',
    });
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript');
  });

  it('never passes raw HTML through, from the template or from values', () => {
    const html = md('<script>x</script> {{customer.name}}', {
      'customer.name': '<img src=x onerror=alert(1)>',
    });
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('does not interpret Markdown or placeholders inside values', () => {
    const html = md('Hi {{customer.name}}', {
      'customer.name': '**bold** [x](https://e.test) {{reset.url}}',
    });
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('https://x.test');
  });

  it('turns newlines inside values into line breaks', () => {
    expect(
      md('{{campaign.message}}', {
        'campaign.message': 'a\n\nb',
      }),
    ).toBe('<p style="__P__">a<br><br>b</p>');
  });

  it('renders unknown placeholders as empty text', () => {
    expect(md('a{{nope}}b', {})).toBe('<p style="__P__">ab</p>');
  });

  it('leaves unsupported syntax (headings, images, code) as escaped text', () => {
    const html = md('# Big\n![i](https://e.test/i.png)', {});
    expect(html).not.toMatch(/<h1|<img/);
    expect(html).toContain('# Big');
  });
});

describe('renderMarkdownText (plain-text alternative)', () => {
  it('strips emphasis, writes links as "text (url)" and lists as dashes', () => {
    expect(
      renderMarkdownText(
        'Hi **{{customer.name}}**\n\n- [Reset]({{reset.url}})\n- _b_\n\n1. x',
        { 'customer.name': '<Asha>', 'reset.url': 'https://x.test/r' },
      ),
    ).toBe('Hi <Asha>\n\n- Reset (https://x.test/r)\n- b\n\n1. x');
  });

  it('does not print unsafe link targets', () => {
    expect(renderMarkdownText('[x](javascript:alert(1))', {})).toBe('x');
  });
});
