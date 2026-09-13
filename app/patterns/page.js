import AppHeader from '../../components/app-header';
import PatternPanel from '../../components/pattern-panel';
export default function PatternsPage() {
  return <main className="page-shell research-page" id="main-content">
    <AppHeader section="Pattern matching research" />
    <section className="research-hero"><div><p className="eyebrow">Observe first · paper only</p>
      <h1>What happened in similar conditions?</h1>
      <p>Compare setups with earlier trades from the same strategy, instrument and direction. Scores are recorded for research. They do not block entries or change position sizes.</p></div></section>
    <PatternPanel />
  </main>;
}
