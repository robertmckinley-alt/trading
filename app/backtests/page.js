import Link from 'next/link';
import BacktestRunner from '../../components/backtest-runner';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default function BacktestsPage() {
  return (
    <main className="page-shell research-page" id="main-content">
      <header className="app-header">
        <Link className="brand-lockup brand-link" href="/" aria-label="DoctorTrades dashboard">
          <span className="brand-mark" aria-hidden="true">DT</span>
          <div><strong>DoctorTrades</strong><span>Backtest Results</span></div>
        </Link>
        <nav className="app-nav" aria-label="Backtest navigation">
          <Link href="/">Dashboard</Link>
          <Link href="/research">Research Lab</Link>
          <Link href="#backtest-results-title">Results</Link>
        </nav>
      </header>
      <section className="research-hero backtest-hero">
        <div>
          <p className="eyebrow">Last 60 days of NQ candles</p>
          <h1>Simulate the rules before trusting the recommendation.</h1>
          <p>Each strategy receives the same historical market window, account size, $500 risk ceiling, transaction costs, and conservative same-candle assumptions.</p>
        </div>
        <aside className="research-safety"><strong>Evidence stays separated</strong><p>Historical trades can reach the 50-trade backtest gate. Only real forward-paper trades count toward live promotion.</p></aside>
      </section>
      <BacktestRunner />
    </main>
  );
}
