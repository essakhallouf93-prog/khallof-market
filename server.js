const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('render.com') || process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined });
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: process.env.SESSION_SECRET || 'change-this-secret-before-production', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7*24*60*60*1000 } }));
app.use(express.static(require('path').join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2*1024*1024 }, fileFilter: (r,f,cb) => cb(null, /^image\/(png|jpeg|webp)$/.test(f.mimetype)) });
const q = (sql, values=[]) => pool.query(sql.replace(/\?/g, () => '$' + (q.i++)), values);
async function query(sql, values=[]) { q.i=0; return q(sql, values); }
const admin = (req,res,next) => req.session.admin ? next() : res.status(401).json({error:'يلزم تسجيل دخول الإدارة'});
const setting = async key => (await query('SELECT value FROM settings WHERE key=?',[key])).rows[0]?.value || '';
async function init(){
 await query(`CREATE TABLE IF NOT EXISTS admins(id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS products(id SERIAL PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL,price NUMERIC(14,2) NOT NULL,unit TEXT DEFAULT 'قطعة',stock NUMERIC(14,3) DEFAULT 0,image TEXT DEFAULT '',active INTEGER DEFAULT 1);
 CREATE TABLE IF NOT EXISTS orders(id BIGSERIAL PRIMARY KEY,customer TEXT,phone TEXT,address TEXT,notes TEXT,items JSONB,total NUMERIC(14,2),status TEXT DEFAULT 'جديد',created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);`);
 const a=await query('SELECT id FROM admins LIMIT 1');
 if(!a.rowCount) await query('INSERT INTO admins(username,password) VALUES(?,?)',[process.env.ADMIN_USER||'admin',bcrypt.hashSync(process.env.ADMIN_PASSWORD||'admin12345',10)]);
 const c=await query('SELECT COUNT(*)::int AS n FROM products');
 if(!c.rows[0].n){ for(const x of [['بندورة','خضار',12000,'كغ',40],['خيار','خضار',10000,'كغ',30],['بطاطا','خضار',8000,'كغ',50],['تفاح','فواكه',18000,'كغ',25],['موز','فواكه',22000,'كغ',20],['حليب','ألبان وأجبان',9000,'ليتر',18],['لبنة','ألبان وأجبان',15000,'علبة',12],['خبز','مخبوزات',3000,'ربطة',40],['زيت نباتي','مواد غذائية',25000,'ليتر',15],['سائل جلي','منظفات',12000,'عبوة',10]]) await query('INSERT INTO products(name,category,price,unit,stock) VALUES(?,?,?,?,?)',x); }
}
app.get('/api/health',(req,res)=>res.json({ok:true,store:'Khallof Market'}));
app.get('/api/products',async(req,res)=>{try{res.json((await query('SELECT * FROM products WHERE active=1 ORDER BY category,name')).rows)}catch(e){res.status(500).json({error:'تعذر تحميل المنتجات'})}});
app.get('/api/config',async(req,res)=>{try{res.json({storeName:'Khallof Market',deliveryFee:Number(await setting('deliveryFee'))||0,currency:await setting('currency')||'ل.س',announcement:await setting('announcement')||'كل احتياجاتك.. في مكان واحد'})}catch(e){res.status(500).json({error:'تعذر تحميل الإعدادات'})}});
app.post('/api/orders',async(req,res)=>{const {customer,phone,address,notes,items}=req.body;if(!customer||!phone||!address||!Array.isArray(items)||!items.length)return res.status(400).json({error:'يرجى إدخال الاسم والهاتف والعنوان وإضافة منتجات'});const client=await pool.connect();try{await client.query('BEGIN');let total=0;const clean=[];for(const item of items){const r=await client.query('SELECT * FROM products WHERE id=$1 AND active=1 FOR UPDATE',[Number(item.id)]);const p=r.rows[0],qty=Number(item.qty);if(!p||!Number.isFinite(qty)||qty<=0)throw Error('يوجد منتج غير صالح في السلة');if(qty>Number(p.stock))throw Error(`الكمية المتوفرة من ${p.name} هي ${p.stock}`);const subtotal=Number(p.price)*qty;clean.push({id:p.id,name:p.name,price:Number(p.price),unit:p.unit,qty,subtotal});total+=subtotal;await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[qty,p.id]);}const fee=Number((await client.query("SELECT value FROM settings WHERE key='deliveryFee'")).rows[0]?.value||0);total+=fee;const r=await client.query('INSERT INTO orders(customer,phone,address,notes,items,total) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[customer,phone,address,notes||'',JSON.stringify(clean),total]);await client.query('COMMIT');res.json({ok:true,orderId:r.rows[0].id,total});}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'تعذر حفظ الطلب'});}finally{client.release();}});
app.post('/api/admin/login',async(req,res)=>{try{const a=(await query('SELECT * FROM admins WHERE username=?',[req.body.username])).rows[0];if(!a||!bcrypt.compareSync(req.body.password||'',a.password))return res.status(401).json({error:'اسم المستخدم أو كلمة المرور غير صحيحة'});req.session.admin={id:a.id,username:a.username};res.json({ok:true,username:a.username});}catch(e){res.status(500).json({error:'تعذر تسجيل الدخول'})}});
app.post('/api/admin/logout',admin,(req,res)=>req.session.destroy(()=>res.json({ok:true})));app.get('/api/admin/me',(req,res)=>res.json({loggedIn:!!req.session.admin,username:req.session.admin?.username}));
app.get('/api/admin/orders',admin,async(req,res)=>{try{res.json((await query('SELECT * FROM orders ORDER BY id DESC')).rows)}catch(e){res.status(500).json({error:'تعذر تحميل الطلبات'})}});
app.patch('/api/admin/orders/:id',admin,async(req,res)=>{const allowed=['جديد','قيد التجهيز','جاهز للتوصيل','خرج للتوصيل','تم التسليم','ملغي'];if(!allowed.includes(req.body.status))return res.status(400).json({error:'حالة غير صالحة'});await query('UPDATE orders SET status=? WHERE id=?',[req.body.status,req.params.id]);res.json({ok:true})});
app.get('/api/admin/products',admin,async(req,res)=>res.json((await query('SELECT * FROM products ORDER BY id DESC')).rows));
app.post('/api/admin/products',admin,upload.single('image'),async(req,res)=>{const {name,category,price,unit,stock}=req.body;if(!name||!category||Number(price)<0)return res.status(400).json({error:'تحقق من بيانات المنتج'});const image=req.file?`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`:(req.body.image||'');const r=await query('INSERT INTO products(name,category,price,unit,stock,image) VALUES(?,?,?,?,?,?) RETURNING id',[name,category,Number(price),unit||'قطعة',Number(stock)||0,image]);res.json({ok:true,id:r.rows[0].id})});
app.put('/api/admin/products/:id',admin,upload.single('image'),async(req,res)=>{const old=(await query('SELECT * FROM products WHERE id=?',[req.params.id])).rows[0];if(!old)return res.status(404).json({error:'المنتج غير موجود'});const b=req.body,image=req.file?`data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`:(b.image??old.image);await query('UPDATE products SET name=?,category=?,price=?,unit=?,stock=?,image=?,active=? WHERE id=?',[b.name,b.category,Number(b.price),b.unit||'قطعة',Number(b.stock)||0,image,b.active==='0'?0:1,req.params.id]);res.json({ok:true})});
app.delete('/api/admin/products/:id',admin,async(req,res)=>{await query('UPDATE products SET active=0 WHERE id=?',[req.params.id]);res.json({ok:true})});
app.get('/api/admin/stats',admin,async(req,res)=>{const r=await query(`SELECT COUNT(*) FILTER (WHERE status!='ملغي') AS orders,COALESCE(SUM(total) FILTER (WHERE status='تم التسليم'),0) AS sales,COUNT(*) FILTER (WHERE status='جديد') AS "newOrders" FROM orders`);const p=await query('SELECT COUNT(*) AS products FROM products WHERE active=1');res.json({...r.rows[0],products:p.rows[0].products})});
app.put('/api/admin/settings',admin,async(req,res)=>{for(const [k,v] of Object.entries({deliveryFee:Number(req.body.deliveryFee)||0,currency:req.body.currency||'ل.س',announcement:req.body.announcement||''}))await query('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[k,String(v)]);res.json({ok:true})});
const port=process.env.PORT||3000;
init().then(()=>app.listen(port,()=>console.log('Khallof Market running on '+port))).catch(e=>{console.error('Database initialization failed',e);process.exit(1)});
