export const metadata = {
  title: 'Next.js + Console Lens',
  description: 'Console Lens example',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
