import Link from 'next/link';
import Comparison from '../../components/buy-hold-comparison';
export const metadata = { title: 'Buy & Hold Comparison | DoctorTrades' };
export default function ComparisonPage() {
  return <main className="page-shell research-page" id="main-content"><header className="app-header"><Link href="/" className="brand-link">DoctorTrades</Link><nav className="app-nav" aria-label="Comparison navigation"><Link href="/">Live Dashboard</Link><Link href="/orb">ORB Lab</Link><Link href="/backtests">All Backtests</Link></nav></header><section className="research-hero"><div><p className="eyebrow">All strategies · Same historical candles</p><h1>Are we beating buy and hold?</h1><p>Compare every historical strategy against continuous NQ buy-and-hold proxies, with $50,000 starting equity. Forward-paper results remain separate.</p></div></section><Comparison /></main>;
}
