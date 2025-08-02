"use server";

import aj from "@/lib/arcjet";
import { serializeCarData } from "@/lib/helper";
import { db } from "@/lib/prisma";
import { request } from "@arcjet/next";
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function getFeaturedCars(limit = 3) {
  try {
    const cars = await db.car.findMany({
      where: {
        featured: true,
        status: "AVAILABLE",
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    return cars.map((car) => serializeCarData(car));
  } catch (error) {
    throw new Error("Error fetching featured cars:", error.message);
  }
}

async function fileToBase64(file) {
  const byteArray = await file.arrayBuffer();
  const buffer = Buffer.from(byteArray);
  return buffer.toString("base64");
}

export async function processImageSearch(file) {
  try {
    // Rate limiting with arcjet
    const req = await request();
    const decision = await aj.protect(req, {
      requested: 1,
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEDDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });

        throw new Error("Too many requests. Please try again later.");
      }
      throw new Error("Request blocked");
    }

    // Validate API key is configured
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Gemini API key is not configured");
    }

    // Initialize Google Generative AI client
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Convert file to Base64 for AI processing
    const base64Image = await fileToBase64(file);

    // Prepare image data for AI model
    const imagePart = {
      inlineData: {
        data: base64Image, // Base64 encoded image
        mimeType: file.type, // MIME type (e.g., "image/jpeg")
      },
    };

    // Detailed prompt for the AI model
    const prompt = `
    Analyze this car image and extract the following information for a search query:
    1. Make (manufacturer)
    2. Body type (SUV, Sedan, Hatchback, etc.)
    3. Color

    Format your response as a clean JSON object with these fields:
    {
      "make": "",
      "bodyType": "",
      "color": "",
      "confidence": 0.0
    }

    For confidence, provide a value between 0 and 1 representing how confident you are in your overall identification.
    Only respond with the JSON object, nothing else.
  `;

    // Generate content using the AI model
    const result = await model.generateContent([imagePart, prompt]);
    const response = await result.response;
    const text = response.text();

    // Clean the response by removing markdown code blocks
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    try {
      const carDetails = JSON.parse(cleanedText);
      return {
        success: true,
        data: carDetails, 
      }
    } catch (error) {
      console.error("Failed to parse AI response:", parseError);
      return {
        success: false,
        error: "Failed to parse AI response"
      }
    }

  } catch (error) {
    throw new Error("AI search error:", error.message);
  }
}
