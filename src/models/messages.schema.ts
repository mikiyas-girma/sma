import mongoose from 'mongoose';

const MessageSchema = new mongoose.Schema({
  message: { type: String, default: '' },
  author: { type: String, default: '' },
  image: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Image'
  },
  voice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Voice'
  },
  timestamp: { type: Date, default: Date.now }
});

export default mongoose.models.Message || mongoose.model('Message', MessageSchema);
