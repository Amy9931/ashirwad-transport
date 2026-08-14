const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bookings.json');

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

let rzp = null;
if (process.env.RZP_KEY_ID && process.env.RZP_KEY_SECRET) {
  rzp = new Razorpay({
    key_id: process.env.RZP_KEY_ID,
    key_secret: process.env.RZP_KEY_SECRET
  });
}

let Booking;
try {
  const mongoose = require('mongoose');
  const MONGODB_URI = process.env.MONGODB_URI;
  if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(() => {
      console.log('MongoDB connected');
    }).catch(err => {
      console.error('MongoDB connection failed:', err.message);
    });
    const schema = new mongoose.Schema({
      id: String,
      vehicle: String,
      seat: Number,
      name: String,
      phone: String,
      pickup: String,
      drop: String,
      email: String,
      amount: Number,
      paymentId: String,
      txnId: String,
      date: String,
      status: String
    });
    Booking = mongoose.model('Booking', schema);
  }
} catch (e) {
  console.error('Mongoose not available, using JSON file storage');
}

app.use(express.json());

// Cache off - taaki users ko hamesha naya version dikhe
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

async function getAllBookings() {
  if (Booking) return await Booking.find().lean();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function seatAlreadyBooked(vehicle, seat) {
  if (Booking) return !!(await Booking.findOne({ vehicle, seat }));
  return (await getAllBookings()).some(b => b.vehicle === vehicle && b.seat === seat);
}

async function createBooking(booking) {
  if (Booking) return await Booking.create(booking);
  const bookings = getAllBookings();
  bookings.push(booking);
  fs.writeFileSync(DATA_FILE, JSON.stringify(bookings, null, 2));
  return booking;
}

// Booked seats ke liye API
app.get('/api/seats/:vehicle', async (req, res) => {
  const vehicle = decodeURIComponent(req.params.vehicle);
  try {
    const bookings = await getAllBookings();
    const bookedSeats = bookings.filter(b => b.vehicle === vehicle).map(b => b.seat);
    res.json({ vehicle, bookedSeats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Razorpay order create karne ke liye API
app.post('/api/create-order', async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  if (!process.env.RZP_KEY_ID || !process.env.RZP_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys configured nahi hain' });
  }
  try {
    const options = {
      amount: amount * 100,
      currency: 'INR',
      receipt: 'AT' + Date.now().toString().slice(-8)
    };
    const order = await rzp.orders.create(options);
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency });
  } catch (err) {
    res.status(500).json({ error: 'Razorpay order create failed: ' + err.message });
  }
});

// Razorpay payment verify karne ke liye API
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const text = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', process.env.RZP_KEY_SECRET).update(text).digest('hex');
  if (expected === razorpay_signature) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Invalid payment signature' });
  }
});

// Booking save karne ke liye API
app.post('/api/bookings', async (req, res) => {
  const { vehicle, seat, name, phone, pickup, drop, email, amount, bookingId, paymentId, txnId } = req.body;
  if (!vehicle || !seat || !name || !phone || !pickup || !drop) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  try {
    if (await seatAlreadyBooked(vehicle, seat)) {
      return res.status(409).json({ error: 'Seat already booked' });
    }
    const booking = {
      id: bookingId || 'AT' + Date.now().toString().slice(-8),
      vehicle,
      seat,
      name,
      phone,
      pickup,
      drop,
      email: email || '',
      amount: amount || 0,
      paymentId: paymentId || '',
      txnId: txnId || '',
      date: new Date().toLocaleString('en-IN'),
      status: 'confirmed'
    };
    const saved = await createBooking(booking);
    res.status(201).json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Saari bookings list karne ke liye (admin)
app.get('/api/bookings', async (req, res) => {
  try {
    res.json(await getAllBookings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Chatbot endpoint
const AI_CONTEXT = `Aap "Ashirwad Transport Agency" ke AI assistant ho. Hindi mein jawab do (thoda English bhi chalega).
Business details:
- Services: Local Taxi, Outstation trips, Airport Transfer, Tour Packages
- Vehicles: Force Urbania (17 seats, AC), Maruti Ertiga (7 seats, AC), Traveller/Bus (group booking)
- Booking: Website par "Seat Booking" section mein vehicle select karke seat book hoti hai
- Payment: Booking advance ₹270 online (Razorpay) se hota hai
- Contact: Phone 9852911976 aur 9102250079, WhatsApp par bhi booking hoti hai
- Fare: Route ke hisaab se alag hota hai, customer ko phone par call karke pata chalta hai
- Kaam ke ghante: 24/7
Customer ko booking, fare, vehicle, route, contact ke baare mein helpful tarike se batana. Jab customer contact number maange to 9852911976 aur 9102250079 batao. Jawab chhota (max 3-4 lines) aur friendly rakho.`;

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message required' });
  }
  if (!genAI) {
    return res.status(500).json({ error: 'GEMINI_API_KEY configured nahi hai' });
  }
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
    const chat = model.startChat({
      history: (history || []).slice(-6).map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
      }))
    });
    const result = await chat.sendMessage(AI_CONTEXT + '\n\nCustomer: ' + message);
    const text = result.response.text();
    res.json({ reply: text });
  } catch (err) {
    res.status(500).json({ error: 'AI error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});
