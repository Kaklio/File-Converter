const { execSync } = require('child_process');
const fs = require('fs');

const videoUrl = process.argv[2];

if (!videoUrl) {
  console.log('Please provide a YouTube URL.');
  console.log('Usage: bun run download -- <YouTube-URL>');
  process.exit(1);
}

try {
  console.log('1. Downloading video with Bun JS runtime support...');
  
  // Tell yt-dlp to use bun as its JavaScript runtime to bypass 403 signature blocks
  execSync(`python -m yt_dlp --js-runtimes bun -o "temp_video.%(ext)s" ${videoUrl}`, { stdio: 'inherit' });

  // Find the downloaded temp files
  const files = fs.readdirSync('.');
  const videoFile = files.find(f => f.startsWith('temp_video.'));

  if (!videoFile) {
    throw new Error('Downloaded video file could not be found.');
  }

  // Get a clean title for the final output
  const titleOutput = execSync(`python -m yt_dlp --js-runtimes bun --get-title ${videoUrl}`).toString().trim();
  const safeTitle = titleOutput.replace(/[<>:"/\\|?*]/g, '').trim();
  const finalOutput = `${safeTitle}.mp4`;

  console.log(`2. Re-encoding "${safeTitle}" to H.264 / AAC for Premiere Pro...`);
  
  // Re-encode into a guaranteed Premiere Pro compatible MP4 file
  const ffmpegCommand = `ffmpeg -y -i "${videoFile}" -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k "${finalOutput}"`;
  execSync(ffmpegCommand, { stdio: 'inherit' });

  // Clean up temporary file
  fs.unlinkSync(videoFile);

  console.log(`\nSuccess! Final file saved as: ${finalOutput}`);

} catch (error) {
  console.error('Error during download or re-encoding:', error.message);
}