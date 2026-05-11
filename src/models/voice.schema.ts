import mongoose from 'mongoose';


const VoiceFileSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  encryptedAudio: [{ type: String, default: '' }],
  preset: { type: String, default: 'ghost' },
  durationSeconds: { type: Number, default: 0 }
});

export default mongoose.models.Voice || mongoose.model('Voice', VoiceFileSchema);
