import { StoreEmails } from './store-emails.service';

/** إشعارات البريد: المستلم الصحيح، والنصوص من المستخدمين لا تصير HTML */
describe('StoreEmails', () => {
  const env = { ...process.env };
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const email = { send: jest.fn(async (m: { to: string; subject: string; html: string; text: string }) => { sent.push(m); return true; }) };
  const prisma = {
    membership: { findFirst: jest.fn(async () => ({ user: { email: 'owner@shop.test', displayName: 'صاحب المتجر' } })) },
  };
  const svc = new StoreEmails(prisma as never, email as never);
  const store = { name: '<b>متجر</b> "أ"', slug: 'shop-a', companyId: 'c1', country: 'YE' };

  beforeEach(() => {
    sent.length = 0;
    Object.assign(process.env, { NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'RVIOS <no-reply@rvios.test>', TEAM_NOTIFY_EMAIL: 'team@rvios.test' });
  });
  afterAll(() => {
    process.env = env;
  });

  it('طلب الشراء يصل صاحب المتجر بلا HTML من اسم المتجر أو العميل', async () => {
    await svc.newOrder(store, { ref: 'RS-1', custName: '<script>x</script>', total: 1500, items: [{ name: 'عطر', qty: 2 }] });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('owner@shop.test');
    expect(sent[0].html).not.toContain('<script>');
    expect(sent[0].html).not.toContain('<b>متجر</b>');
    expect(sent[0].html).toContain('&lt;script&gt;');
    expect(sent[0].text).toContain('عطر × 2');
  });

  it('طلب متجر يصل الفريق وصاحبه، والتفعيل يصل صاحبه', async () => {
    await svc.storeRequested(store, 61, 'USD');
    expect(sent.map((m) => m.to)).toEqual(['team@rvios.test', 'owner@shop.test']);
    await svc.storeActivated(store, 'https://store.test/s/shop-a');
    expect(sent[2].to).toBe('owner@shop.test');
    expect(sent[2].text).toContain('https://store.test/s/shop-a');
  });

  it('لا يُرسل شيء بلا ضبط البريد أو في الاختبارات', async () => {
    delete process.env.RESEND_API_KEY;
    await svc.newOrder(store, { ref: 'RS-2', custName: '', total: 1, items: [] });
    process.env.RESEND_API_KEY = 'k';
    process.env.NODE_ENV = 'test';
    await svc.storeActivated(store, 'x');
    expect(sent).toHaveLength(0);
  });
});
