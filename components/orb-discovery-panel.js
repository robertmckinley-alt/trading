const money = n => Number.isFinite(n) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n) : '—';
export default function OrbDiscoveryPanel({ report }) {
  return <section className="research-section" id="orb-discovery">
    <div className="section-heading"><div><span className="section-kicker">Daily strategy research</span><h2>ORB discovery queue</h2></div></div>
    {!report ? <p>Waiting for the updated VPS research worker. Each daily run tests up to four of twelve registered variations using cached candles.</p> : <>
      <p><strong>{report.status.replaceAll('-', ' ')}</strong>{report.generatedAt && ` · Report ${report.generatedAt}`}</p>
      <p>{report.label || report.message}</p>
      <p>{report.testedToday ?? 0} tested today · {report.remaining ?? '—'} untested · At most four qualifying experiments receive separate $50,000 paper accounts. Existing accounts keep their journals.</p>
      <div className="research-table-wrap"><table><thead><tr><th>Experiment</th><th>Stage</th><th>2025 training P&amp;L</th><th>2026 test P&amp;L</th><th>Test improvement vs baseline</th><th>Doubled-cost test P&amp;L</th><th>Reason</th></tr></thead>
        <tbody>{(report.trials || []).map(t => <tr key={t.id}><th>{t.name}</th><td>{t.paperSelected ? 'Selected for separate paper account' : t.status}</td><td>{money(t.training?.netPnlUsd)}</td><td>{money(t.testing?.netPnlUsd)}</td><td>{money(t.improvementUsd)}</td><td>{money(t.doubledCosts?.netPnlUsd)}</td><td>{t.issues?.join(' ') || 'Historical gates passed. Forward evidence still required.'}</td></tr>)}</tbody></table></div>
      <details><summary>Forward performance monitoring</summary><p>Last 20 data-complete closed trades. A deterioration flag requests review; it does not rewrite the strategy or erase losses.</p>
        <div className="research-table-wrap"><table><thead><tr><th>Account</th><th>Complete trades</th><th>Gap trades</th><th>Recent expectancy</th><th>Status</th></tr></thead><tbody>{(report.monitoring || []).map(a => <tr key={a.slug}><th>{a.slug}</th><td>{a.verifiedTrades}</td><td>{a.gapTrades}</td><td>{money(a.recent.expectancyUsd)}</td><td>{a.status}</td></tr>)}</tbody></table></div>
      </details>
    </>}
    <p>All attempted variations remain visible, including failures. Passing historical tests is permission for paper observation only. No automatic live deployment, confidence percentage, or change to an existing strategy.</p>
  </section>;
}
