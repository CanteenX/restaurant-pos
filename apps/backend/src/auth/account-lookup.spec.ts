import { emailAccountQuery, normaliseEmail } from './account-lookup';

describe('account lookup by email (login and reset share it)', () => {
  it('normalises case and surrounding spaces', () => {
    expect(normaliseEmail('  Alice@X.com ')).toBe('alice@x.com');
  });

  it('resolves ONE active account: case-insensitive, oldest first, then by id', () => {
    expect(emailAccountQuery(' Alice@X.com')).toEqual({
      where: {
        email: { equals: 'alice@x.com', mode: 'insensitive' },
        isActive: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });
});
