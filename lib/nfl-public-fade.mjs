// Research-only public fade filter. Never infer expected value from ticket counts.
// Require independently timestamped ticket and executable opposing-side price snapshots.
export function evaluatePublicFade(input,opts={}) {
 const {minTickets=80,maxAgeMinutes=90,minMinutesBeforeKickoff=5,minSample=100,minDivergence=12,maxDecimalPrice=3.5,asOf=Date.now()}=opts;
 const {eventId,market,side,ticketPct,moneyPct,ticketCount,observedAt,kickoff,source,opposingOdds,oddsObservedAt,opposingLine,publicLine,marketMovement}=input||{};
 const reasons=[],notes=[];
 const pct=ticketPct===null||ticketPct===undefined?NaN:Number(ticketPct);
 const money=moneyPct===null||moneyPct===undefined?NaN:Number(moneyPct);
 const count=ticketCount===null||ticketCount===undefined?NaN:Number(ticketCount);
 const price=opposingOdds===null||opposingOdds===undefined?NaN:Number(opposingOdds);
 const observation=Date.parse(observedAt),priceTime=Date.parse(oddsObservedAt),start=Date.parse(kickoff);
 const validMarket=['spread','total','moneyline'].includes(market);
 const validSide=market==='total'?['over','under'].includes(side):['home','away'].includes(side);
 if(!eventId||!validMarket||!validSide)reasons.push('invalid_market');
 if(!Number.isFinite(pct)||pct<0||pct>100)reasons.push('invalid_ticket_percentage');
 if(!Number.isFinite(money)||money<0||money>100)reasons.push('missing_or_invalid_money_percentage');
 if(!Number.isInteger(count)||count<minSample)reasons.push('insufficient_ticket_sample');
 if(!source||typeof source!=='string')reasons.push('missing_source');
 if(!Number.isFinite(start)||start<=asOf)reasons.push('game_started_or_invalid_kickoff');
 if(!Number.isFinite(observation)||observation>asOf||asOf-observation>maxAgeMinutes*60000||observation>=start-minMinutesBeforeKickoff*60000)reasons.push('stale_or_future_ticket_snapshot');
 if(!Number.isFinite(priceTime)||priceTime>asOf||asOf-priceTime>maxAgeMinutes*60000||priceTime>=start-minMinutesBeforeKickoff*60000)reasons.push('stale_or_future_odds_snapshot');
 if(!Number.isFinite(price)||price===0||Math.abs(price)<100)reasons.push('invalid_opposing_odds');
 if(pct<minTickets)reasons.push('below_ticket_threshold');
 const divergence=Number.isFinite(money)&&Number.isFinite(pct)?pct-money:null;
 if(divergence===null||divergence<minDivergence)reasons.push('weak_ticket_money_divergence');
 const candidateSide=side==='home'?'away':side==='away'?'home':side==='over'?'under':'over';
 if(market!=='moneyline') {
  if(!Number.isFinite(Number(opposingLine))||!Number.isFinite(Number(publicLine)))reasons.push('missing_line');
  else if(Math.abs(Number(opposingLine)+Number(publicLine))>0.000001)reasons.push('nonmatching_opposing_line');
 }
 const decimal=Number.isFinite(price)&&Math.abs(price)>=100?(price>0?1+price/100:1+100/-price):null;
 if(decimal!==null&&decimal>maxDecimalPrice)notes.push('high_price_variance');
 if(marketMovement===undefined||marketMovement===null)notes.push('line_movement_unverified');
 if(reasons.length===0)notes.push('signal_is_not_evidence_of_positive_ev');
 const status=reasons.length?'rejected':notes.includes('line_movement_unverified')?'watchlist':'qualified';
 return {eligible:status==='qualified',status,classification:'research_only_not_a_pick',eventId,market,publicSide:side,candidateSide,ticketPct:pct,moneyPct:Number.isFinite(money)?money:null,ticketCount:Number.isFinite(count)?count:null,divergence,opposingOdds:price,opposingLine:market==='moneyline'?null:Number(opposingLine),observedAt,oddsObservedAt,source,reasons,notes};
}
