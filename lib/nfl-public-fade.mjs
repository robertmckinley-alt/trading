// NFL public-fade research signal. Inputs must be timestamped before kickoff.
// Never use this signal alone as evidence of positive expected value.
export function evaluatePublicFade(input,{minTickets=80,maxAgeMinutes=90,minMinutesBeforeKickoff=5}={}) {
 const {eventId,market,side,ticketPct,moneyPct,observedAt,kickoff,odds,source}=input||{};
 const reasons=[];
 const pct=Number(ticketPct),price=Number(odds);
 const observation=Date.parse(observedAt),start=Date.parse(kickoff),now=Date.now();
 if(!eventId||!['spread','total','moneyline'].includes(market)||!['home','away','over','under'].includes(side))reasons.push('invalid_market');
 if(!Number.isFinite(pct)||pct<0||pct>100)reasons.push('invalid_ticket_percentage');
 if(!Number.isFinite(observation)||!Number.isFinite(start)||observation>=start-minMinutesBeforeKickoff*60000)reasons.push('invalid_or_late_snapshot');
 if(Number.isFinite(observation)&&(observation>now+60000||now-observation>maxAgeMinutes*60000))reasons.push('stale_snapshot');
 if(!Number.isFinite(price)||price===0||Math.abs(price)<100)reasons.push('invalid_odds');
 if(!source)reasons.push('missing_source');
 if(pct<minTickets)reasons.push('below_threshold');
 const opposing=side==='home'?'away':side==='away'?'home':side==='over'?'under':'over';
 const money=moneyPct===null||moneyPct===undefined?null:Number(moneyPct);
 const divergence=Number.isFinite(money)?pct-money:null;
 return {eligible:reasons.length===0,market,eventId,publicSide:side,candidateSide:opposing,ticketPct:pct,moneyPct:money,divergence,odds,observedAt,source,reasons,classification:'research_only_not_a_pick'};
}
