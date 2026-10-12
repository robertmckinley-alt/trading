'use client';
import { useState } from 'react';
export default function NflTabs({counts={}}){
 const [active,setActive]=useState('paper-trading');
 const tabs=[['paper-trading','Accounts'],['value-bets','Best bets'],['player-props','Props'],['predicted-winners','Winners'],['winner-parlays','Winner parlays'],['player-parlays','Player parlays'],['full-slate','Games']];
 return <nav className="nfl-tabs" aria-label="NFL EDGE sections">{tabs.map(([id,label])=><button type="button" key={id} aria-pressed={active===id} onClick={()=>{setActive(id);document.querySelectorAll('[data-nfl-panel]').forEach(el=>{el.hidden=el.id!==id});}}>{label} ({counts[id]||0})</button>)}</nav>;
}
