const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '32kb'}));

const dataFile = process.env.DATA_FILE || path.join(__dirname, 'battlehub-data.json');
const defaultData = {players: {}, tournaments: [], joined: {}, payments: [], presence: {}};
function loadData(){try{return {...defaultData, ...JSON.parse(fs.readFileSync(dataFile, 'utf8'))}}catch{return structuredClone(defaultData)}}
function saveData(data){fs.writeFileSync(dataFile, JSON.stringify(data, null, 2))}
let data = loadData();

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || '';
const validRazorpayKeyId = /^rzp_(test|live)_/.test(razorpayKeyId);
const razorpay = validRazorpayKeyId && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({key_id: razorpayKeyId, key_secret: process.env.RAZORPAY_KEY_SECRET}) : null;

app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next()});
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'BattleHub Arena'}));
app.post('/api/player', (req,res)=>{
  const id = String(req.body.id || '').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
  const name = String(req.body.name || 'Player').trim().slice(0,40);
  const freeFireId = String(req.body.freeFireId || '').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,40);
  if(!id) return res.status(400).json({error:'Player id required'});
  data.players[id] ||= {id,name,freeFireId,balance:0,joined:[],createdAt:new Date().toISOString()};
  data.players[id].name = name || data.players[id].name;
  if(freeFireId) data.players[id].freeFireId = freeFireId;
  data.presence[id] = Date.now(); saveData(data); res.json(data.players[id]);
});
app.post('/api/presence',(req,res)=>{const id=String(req.body.id||'').slice(0,40);if(id)data.presence[id]=Date.now();saveData(data);res.json({ok:true})});
app.get('/api/presence',(_req,res)=>{const cutoff=Date.now()-75000;const online=Object.values(data.presence).filter(ts=>ts>=cutoff).length;res.json({online,offline:Math.max(0,Object.keys(data.players).length-online)})});
app.get('/api/tournaments',(_req,res)=>res.json(data.tournaments));
app.post('/api/admin/tournament',(req,res)=>{
  const token=req.header('x-admin-token');
  if(!process.env.ADMIN_TOKEN || token!==process.env.ADMIN_TOKEN) return res.status(401).json({error:'Unauthorized'});
  const entry=Math.max(5,Number(req.body.entry||0)); const slots=Math.max(2,Number(req.body.slots||0));
  if(!req.body.title||!Number.isFinite(entry)||!Number.isFinite(slots)) return res.status(400).json({error:'Invalid tournament'});
  const tournament={id:String(Date.now()),title:String(req.body.title).slice(0,80),game:req.body.game==='Free Fire India'?'Free Fire India':'Free Fire',mode:['Solo','Duo','Squad'].includes(req.body.mode)?req.body.mode:'Solo',entry,prize:Math.max(0,Number(req.body.prize||0)),slots,filled:0,time:String(req.body.time||'Date pending')};
  data.tournaments.unshift(tournament);saveData(data);res.status(201).json(tournament);
});
app.post('/api/payments/order', async(req,res)=>{
  if(!razorpay) return res.status(503).json({error:'Payments are not configured'});
  const playerId=String(req.body.playerId||'').slice(0,40); const amount=Math.max(5,Number(req.body.amount||0));
  if(!data.players[playerId]) return res.status(400).json({error:'Unknown player'});
  try{const order=await razorpay.orders.create({amount:Math.round(amount*100),currency:'INR',receipt:`BH${Date.now()}`});res.json({orderId:order.id,amount:order.amount,keyId:process.env.RAZORPAY_KEY_ID})}catch(e){res.status(502).json({error:'Payment order failed'})}
});
app.post('/api/payments/verify',(req,res)=>{
  if(!process.env.RAZORPAY_KEY_SECRET) return res.status(503).json({error:'Payments are not configured'});
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature,playerId,amount}=req.body;
  const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  const signature=String(razorpay_signature||'');if(signature.length!==expected.length)return res.status(401).json({error:'Invalid signature'});if(!crypto.timingSafeEqual(Buffer.from(expected,'utf8'),Buffer.from(signature,'utf8'))) return res.status(401).json({error:'Invalid signature'});
  if(data.payments.some(p=>p.paymentId===razorpay_payment_id)) return res.status(409).json({error:'Payment already applied'});
  const player=data.players[String(playerId||'').slice(0,40)];if(!player)return res.status(400).json({error:'Unknown player'});
  player.balance += Math.max(5,Number(amount||0));data.payments.push({paymentId:razorpay_payment_id,orderId:razorpay_order_id,playerId,amount,createdAt:new Date().toISOString()});saveData(data);res.json({verified:true,balance:player.balance});
});
app.post('/api/tournaments/join',(req,res)=>{
  const player=data.players[String(req.body.playerId||'').slice(0,40)];const tournament=data.tournaments.find(t=>t.id===String(req.body.tournamentId));
  if(!player||!tournament)return res.status(400).json({error:'Invalid player or tournament'});if(player.joined.includes(tournament.id))return res.status(409).json({error:'Already joined'});if(tournament.filled>=tournament.slots)return res.status(409).json({error:'Tournament full'});if(player.balance<tournament.entry)return res.status(402).json({error:'Insufficient balance'});
  player.balance-=tournament.entry;player.joined.push(tournament.id);tournament.filled++;saveData(data);res.json({joined:true,balance:player.balance});
});
app.get('/api/admin/players.csv',(req,res)=>{
  if(!process.env.ADMIN_TOKEN || req.header('x-admin-token')!==process.env.ADMIN_TOKEN)return res.status(401).json({error:'Unauthorized'});
  const safe=(value='')=>{let text=String(value).replace(/"/g,'""');if(/^[-+@=]/.test(text))text="'"+text;return `"${text}"`};
  const rows=[['Player Name','BattleHub ID','Free Fire ID','Wallet Balance','Joined Tournament IDs','Registered At']];
  Object.values(data.players).forEach(player=>rows.push([player.name||'',player.id||'',player.freeFireId||'',player.balance||0,(player.joined||[]).join(';'),player.createdAt||'']));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="battlehub-players.csv"');
  res.send('\uFEFF'+rows.map(row=>row.map(safe).join(',')).join('\r\n'));
});
app.get('/api/config',(_req,res)=>res.json({keyId:validRazorpayKeyId ? razorpayKeyId : null,paymentsReady:Boolean(razorpay)}));
app.use(express.static(__dirname,{extensions:['html']}));
const port=Number(process.env.PORT||8080);app.listen(port,'0.0.0.0',()=>console.log(`BattleHub Arena listening on ${port}`));
