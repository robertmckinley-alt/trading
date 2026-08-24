import './globals.css';

export const metadata = {
  title: 'Lucid NQ Paper Trader',
  description: 'Vercel-ready DoctorTrades-style NQ paper trading sandbox.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
