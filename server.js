const express = require("express");
const app = express();
const { Server } = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const dotenv = require("dotenv");
const { Readable } = require("stream");
const axios = require("axios");
const OpenAI = require("openai");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
dotenv.config();
const http = require("http");
const server = http.createServer(app);
const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_KEY,
});

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});

let recordedChunks = [];

io.on("connection", (socket) => {
  console.log("🚀 New client connected");

  socket.on("video-chunks", async (data) => {
    console.log("📦 Received video chunks", data);
    const writeStream = fs.createWriteStream("temp_upload/" + data.filename);
    recordedChunks.push(data.chunks);
    const videoBlob = new Blob(recordedChunks, {
      type: "video/webm; codecs=vp9",
    });
    const buffer = Buffer.from(await videoBlob.arrayBuffer());

    const readStream = Readable.from(buffer);
    readStream.pipe(writeStream).on("finish", () => {
      console.log("📦 Finished writing file");
    });
  });
  socket.on("process-video", async (data) => {
    console.log("📽️ Processing video", data);
    // ffmpeg -i input.webm -c copy -map 0 -movflags +faststart output.webm
    // This command will copy the video and audio streams from the input.webm file to the output.webm file without re-encoding them and adding metadata at the beginning of the file.
    recordedChunks = [];
    fs.readFile("temp_upload/" + data.filename, async (err, file) => {
      const processing = await axios.post(
        `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
        {
          filename: data.filename,
        }
      );
      if (processing.data.status !== 200) {
        return console.log("❌ Error processing video");
      }
      const Key = data.filename;
      const Bucket = process.env.AWS_BUCKET_NAME;
      const ContentType = "video/webm";
      const command = new PutObjectCommand({
        Key,
        Bucket,
        ContentType,
        Body: file,
      });
      const fileStatus = await s3.send(command);

      if (fileStatus.$metadata.httpStatusCode === 200) {
        console.log("✅ File uploaded to S3");

        if (processing.data.plan === "PRO") {
          fs.stat("temp_upload/" + data.filename, async (err, stats) => {
            if (!err) {
              if (stats.size < 25000000) {
                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(`temp_upload/${data.filename}`),
                  model: "whisper-1",
                  response_format: "text",
                });
                if (transcription) {
                  const completion = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    response_format: {
                      type: "json_object",
                    },
                    messages: [
                      {
                        role: "system",
                        content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transcription}) and then return it in json format as {"title": <the title you gave>, "summary": <the summary you created>}`,
                      },
                    ],
                  });
                  const titleAndSummaryGenerated = await axios.post(
                    `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                    {
                      filename: data.filename,
                      content: completion.choices[0].message.content,
                      transcript: transcription,
                    }
                  );
                  if (titleAndSummaryGenerated.data.status !== 200) {
                    return console.log("❌ Error generating title and summary");
                  }
                }
              }
            }
          });
        }

        const stopProcessing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
          {
            filename: data.filename,
          }
        );
        if (stopProcessing.data.status !== 200) {
          return console.log("❌ Error stopping processing");
        }

        if (stopProcessing.data.status === 200) {
          fs.unlink(`temp_upload/${data.filename}`, (err) => {
            if (err) {
              console.error("❌ Error deleting file", err);
              return;
            }
            console.log(`✅ File deleted: ${data.filename}`);
          });
        }
      } else {
        console.log("❌ Error uploading to S3");
      }
    });
  });

  socket.on("disconnect", () => {
    console.log("🚫 Client disconnected");
  });
});

server.listen(5000, () => {
  console.log("✅ Server is running on port 5000");
});
