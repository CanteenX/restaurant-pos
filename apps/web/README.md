This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

Fonts are self-hosted: `app/fonts.ts` loads [Geist](https://vercel.com/font) (npm `geist`) and Noto Sans Devanagari (npm `@fontsource-variable/noto-sans-devanagari`, for Hindi) with `next/font/local`, so `next build` never contacts Google Fonts and works offline. Do not use the Google `next/font` loader; `lib/self-hosted-fonts.test.ts` fails if it is reintroduced. Both fonts are SIL OFL 1.1; their licence texts are committed in `public/licenses/` (served at `/licenses/*` and copied into the Docker image) and listed in the root `NOTICE`. After bumping either font package, re-copy its licence there (the test checks they match).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
