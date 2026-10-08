import Link from "next/link";

const strategies = [
  ["Receiving yards", "Targets, routes, matchup and game script"],
  ["Receptions", "Target share and catch probability"],
  ["Rushing yards", "Carries, offensive line and defensive fronts"],
  ["Passing yards", "Dropbacks, pace and pressure"],
  ["Touchdown props", "Red-zone usage and opportunity"],
  ["Injury-driven props", "Depth-chart changes and market repricing"],
];

export const metadata = {
  title: "NFL Edge | Paper Prediction Lab",
  description: "NFL player prop research and paper strategy dashboard",
};

export default function NFLPage() {
  return (
    <main style={{maxWidth:1100,margin:"0 auto",padding:"32px 20px",color:"#e5e7eb",minHeight:"100vh",background:"#0b1220"}}>
      <nav style={{marginBottom:28}}><Link href="/" style={{color:"#93c5fd"}}>← Trading Dashboard</Link></nav>
      <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center",flexWrap:"wrap"}}>
        <div><p style={{color:"#94a3b8",letterSpacing:2}}>PREDICTION LAB</p><h1 style={{fontSize:38,fontWeight:800,margin:"8px 0"}}>NFL EDGE</h1><p style={{color:"#94a3b8"}}>Player props • News & injuries • Probability & expected value</p></div>
        <span style={{border:"1px solid #64748b",padding:"8px 12px",borderRadius:20}}>PAPER MODE ONLY</span>
      </div>
      <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:14,margin:"28px 0"}}>
        {[["Simulated capital","$300,000"],["Strategies","6"],["Verified picks","0"],["Live feed","Not connected"]].map(([label,value])=><article key={label} style={{background:"#162238",border:"1px solid #334155",borderRadius:12,padding:20}}><div style={{color:"#94a3b8",fontSize:13}}>{label}</div><strong style={{fontSize:25}}>{value}</strong></article>)}
      </section>
      <section style={{background:"#162238",border:"1px solid #334155",borderRadius:12,padding:22,marginBottom:20}}>
        <h2 style={{fontSize:22,marginBottom:8}}>Top prop opportunities</h2>
        <p style={{color:"#94a3b8"}}>No picks yet. Odds, injury and projection providers must be verified and connected before this board publishes opportunities. No fabricated projections or EV estimates.</p>
      </section>
      <section><h2 style={{fontSize:22,marginBottom:16}}>Strategy research accounts</h2><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(270px,1fr))",gap:14}}>{strategies.map(([name,desc])=><article key={name} style={{background:"#162238",border:"1px solid #334155",borderRadius:12,padding:18}}><strong>{name}</strong><p style={{color:"#94a3b8",margin:"8px 0"}}>{desc}</p><p style={{fontSize:13,color:"#a7f3d0"}}>$50,000 simulated • Awaiting validation</p></article>)}</div></section>
      <p style={{color:"#94a3b8",fontSize:13,marginTop:28}}>Linemate access, licensed odds, official injury news and Telegram notifications are planned integrations, not yet active. NFL EDGE is research software, not a betting service.</p>
    </main>
  );
}
