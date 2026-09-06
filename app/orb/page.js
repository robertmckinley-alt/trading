import Link from 'next/link';
import BacktestRunner from '../../components/backtest-runner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata = { title: 'ORB Lab | DoctorTrades' };

export default function OrbPage() {
  return <main className="page-shell research-page" id="main-content">
    <header className="app-header">
      <Link className="brand-lockup brand-link" href="/" aria-label="DoctorTrades dashboard"><span className="brand-mark" aria-hidden="true">DT</span><div><strong>DoctorTrades</strong><span>ORB Lab</span></div></Link>
      <nav className="app-nav" aria-label="ORB navigation"><Link href="/">Dashboard</Link><Link href="/backtests">Other Backtests</Link><Link href="/research">Research Lab</Link><Link href="#orb-learning-title">ORB Comparison</Link></nav>
    </header>
    <section className="research-hero backtest-hero"><div><p className="eyebrow">Opening range breakout · January 2025 onward</p><h1>Every ORB experiment. Every result.</h1><p>Compare each variant below, with its own profit curve, annual results, risk rejections, and searchable trade history. No experiment dropdown.</p></div><aside className="research-safety"><strong>Understand the trade count</strong><p>A signal is not a filled trade. Research tests one NQ contract with no dollar risk cap. Invalid entry gaps can still prevent a fill. Each setup keeps its actual stop and trading costs.</p></aside></section>
    <BacktestRunner view="orb" />
  </main>;
}
