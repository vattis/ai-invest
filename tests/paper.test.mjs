import test from 'node:test';
import assert from 'node:assert/strict';
import {marketTime,parseUs,parseKr} from '../worker/quotes.mjs';
import {initialState,applyPair,value} from '../worker/paper.mjs';

test('market hours honor Seoul opening and New York daylight saving',()=>{
  assert.equal(marketTime('kr',new Date('2026-11-02T00:00:00Z')).open,true);
  assert.equal(marketTime('kr',new Date('2026-11-02T06:30:00Z')).open,false);
  assert.equal(marketTime('us',new Date('2026-07-01T13:30:00Z')).open,true);
  assert.equal(marketTime('us',new Date('2026-11-02T14:30:00Z')).open,true);
});
test('quote parsing rejects stale prices and uses provider timestamps',()=>{
  const now=Date.parse('2026-11-02T14:31:00Z');
  const us=parseUs({trades:{AAPL:{p:100,t:'2026-11-02T14:30:59Z'},MSFT:{p:50,t:'2026-11-02T14:20:00Z'}}},{quotes:{AAPL:{bp:99,ap:101,t:'2026-11-02T14:30:59Z'}}},now);
  assert.deepEqual(Object.keys(us),['AAPL']);assert.equal(us.AAPL.ask,101);
  assert.equal(parseKr('005930',{rt_cd:'0',output:{stck_prpr:'70000',stck_cntg_hour:'093000'}},new Date('2026-11-02T00:30:30Z')).price,70000);
  assert.equal(parseKr('005930',{rt_cd:'0',output:{stck_prpr:'70000',stck_cntg_hour:'090000'}},new Date('2026-11-02T00:30:30Z')),null);
});
test('paired paper fills wait for both decisions and a later quote; repeats are idempotent',()=>{
  const state=initialState(),base=Date.parse('2026-11-02T14:30:00Z');
  const proposal=cohort=>({cohort,completed_at:new Date(base+(cohort==='A'?1000:2000)).toISOString(),expires_at:new Date(base+60000).toISOString(),decision:{orders:[{symbol:'AAPL',action:'BUY',target_weight:0.2,reason:'test'}]}});
  const pair={A:proposal('A'),B:proposal('B')};
  assert.deepEqual(applyPair(state,'us','job1',pair,{AAPL:{price:100,ask:101,as_of:new Date(base+1500).toISOString(),source:'alpaca_iex'}},base+3000),[]);
  assert.equal(state.processedJobs.length,0);
  const quote={AAPL:{price:100,ask:101,as_of:new Date(base+3000).toISOString(),source:'alpaca_iex'}};
  const trades=applyPair(state,'us','job1',pair,quote,base+4000);
  assert.equal(trades.length,2);assert.equal(trades[0].price,101.0505);
  assert.equal(state.accounts.us.A.cash,state.accounts.us.B.cash);
  assert.equal(value(state.accounts.us.A,quote),value(state.accounts.us.B,quote));
  assert.deepEqual(applyPair(state,'us','job1',pair,quote,base+5000),[]);
  assert.equal(state.trades.length,2);
});
test('missing requested quote keeps the paired job pending without partial fills',()=>{
  const state=initialState(),base=Date.parse('2026-11-02T14:30:00Z');
  const decision={orders:[{symbol:'AAPL',action:'BUY',target_weight:0.2,reason:'test'},{symbol:'MSFT',action:'BUY',target_weight:0.2,reason:'test'}]};
  const p={completed_at:new Date(base+1000).toISOString(),expires_at:new Date(base+60000).toISOString(),decision};
  assert.deepEqual(applyPair(state,'us','job2',{A:p,B:p},{AAPL:{price:100,as_of:new Date(base+2000).toISOString()}},base+3000),[]);
  assert.equal(state.processedJobs.length,0);assert.equal(state.trades.length,0);
});
