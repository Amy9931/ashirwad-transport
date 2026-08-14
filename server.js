const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bookings.json');

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
      date: String,
      status: String
    });
    Booking = mongoose.model('Booking', schema);
  }
} catch (e) {
  console.error('Mongoose not available, using JSON file storage');
}

app.use(express.json());
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
  const { vehicle, seat, name, phone, pickup, drop, email, amount, bookingId, paymentId } = req.body;
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

app.listen(PORT, () => {
  console.log(`Server chal raha hai: http://localhost:${PORT}`);
});
