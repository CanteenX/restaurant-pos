import { renderTicketReply } from '@nventra/types/dist/node/email-renderer';

describe('shared ticket reply renderer', () => {
  it('returns a single-line subject and both email bodies', () => {
    const reply = renderTicketReply({
      subject: ' Re: Table printer\r\nSecond line ',
      customerName: 'Asha Rao',
      body: 'Please try the following.\n\nOpen POS settings.',
    });

    expect(reply.subject).toBe('Re: Table printer Second line');
    expect(reply.html).toMatch(/^<!DOCTYPE html>/);
    expect(reply.html).toContain('Hi Asha Rao,');
    expect(reply.html).toContain(
      'Please try the following.<br><br>Open POS settings.',
    );
    expect(reply.text).toContain(
      'Hi Asha Rao,\n\nPlease try the following.\n\nOpen POS settings.',
    );
  });

  it('renders customer and reply content literally, including HTML and links', () => {
    const customerName = '<b>**Asha**</b> {{reply.body}}';
    const body =
      '<img src=x onerror=alert(1)>\n[unsafe](javascript:alert(1))\n' +
      '[docs](https://example.test/docs)';
    const reply = renderTicketReply({
      subject: 'Re: <Printer>',
      customerName,
      body,
    });

    expect(reply.subject).toBe('Re: <Printer>');
    expect(reply.html).toContain('<title>Re: &lt;Printer&gt;</title>');
    expect(reply.html).toContain(
      '&lt;b&gt;**Asha**&lt;/b&gt; &#123;&#123;reply.body&#125;&#125;',
    );
    expect(reply.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(reply.html).toContain('[unsafe](javascript:alert(1))');
    expect(reply.html).toContain('[docs](https://example.test/docs)');
    expect(reply.html).not.toMatch(/<img|<strong|\bhref=/i);
    expect(reply.text).toContain(customerName);
    expect(reply.text).toContain(body);
  });
});
