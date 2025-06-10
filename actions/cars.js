"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase";
import { v4 as uuidv4 } from "uuid";
import { revalidatePath } from "next/cache";
import { serializeCarData } from "@/lib/helper";

async function fileToBase64(file) {
  const byteArray = await file.arrayBuffer();
  const buffer = Buffer.from(byteArray);
  return buffer.toString("base64");
}

export async function processCarImageWithAI(file) {
  try {
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
    Analyze this car image and extract the following information:
    1. Make (manufacturer)
    2. Model
    3. Year (approximately)
    4. Color
    5. Body type (SUV, Sedan, Hatchback, etc.)
    6. Mileage
    7. Fuel type (your best guess from "Petrol", "Diesel", "Electric", "Hybrid", "Plug-in Hybrid")
    8. Transmission type (your best guess)
    9. Price (your best guess)
    9. Short Description as to be added to a car listing

    Format your response as a clean JSON object with these fields:
    {
      "make": "",
      "model": "",
      "year": 0000,
      "color": "",
      "price": "",
      "mileage": "",
      "bodyType": "",
      "fuelType": "",
      "transmission": "",
      "description": "",
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

    // Parse the JSON response
    try {
      // Parse the JSON response from AI
      const carDetails = JSON.parse(cleanedText);

      // Validate required fields exist in response
      const requiredFields = [
        "make",
        "model",
        "year",
        "color",
        "bodyType",
        "price",
        "mileage",
        "fuelType",
        "transmission",
        "description",
        "confidence",
      ];

      const missingFields = requiredFields.filter((field) => !(field in carDetails));

      if (missingFields.length > 0) {
        throw new Error(`AI response missing required fields: ${missingFields.join(", ")}`);
      }

      // Return success response with data
      return {
        success: true,
        data: carDetails,
      };
    } catch (parseError) {
      console.error("Failed to parse AI response:", parseError);
      console.log("Raw response:", text);
      return {
        success: false,
        error: "Failed to parse AI response",
      };
    }
  } catch (error) {
    console.error();
    throw new Error("Gemini API error:" + error.message);
  }
}

export async function addCar({ carData, images }) {
  try {
    // Authenticate user
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized!");

    // Verify user exists in database
    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    // Generate unique ID and storage path for car
    const carId = uuidv4();
    const folderPath = `cars/${carId}`;

    // Initialize Supabase client
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const imageUrls = [];

    // Process each uploaded image
    for (let i = 0; i < images.length; i++) {
      const base64Data = images[i];

      // Validate image format
      if (!base64Data || !base64Data.startsWith("data:image/")) {
        console.warn("Skipping invalid image data");
        continue;
      }

      // // Extract pure Base64 data (remove header) => (data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA... (long Base64 string)
      const base64 = base64Data.split(",")[1];
      const imageBuffer = Buffer.from(base64, "base64");

      // Extract file extension from MIME type
      const mimeMatch = base64Data.match(/data:image\/([a-zA-Z0-9]+);/);
      const fileExtension = mimeMatch ? mimeMatch[1] : "jpeg";

      // Create unique filename
      const fileName = `image-${Date.now()}-${i}.${fileExtension}`;
      const filePath = `${folderPath}/${fileName}`;

      // Upload to Supabase storage
      const { data, error } = await supabase.storage.from("car-images").upload(filePath, imageBuffer, {
        contentType: `image/${fileExtension}`,
      });

      if (error) {
        console.error("Error uploading image:", error);
        throw new Error(`Failed to upload image: ${error.message}`);
      }

      // Get the public URL for the uploaded file
      const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/car-images/${filePath}`; // disable cache in config

      imageUrls.push(publicUrl);
    }

    // Validate at least one image was uploaded
    if (imageUrls.length === 0) {
      throw new Error("No valid images were uploaded");
    }

    // Create car record in database
    const car = await db.car.create({
      data: {
        id: carId,
        make: carData.make,
        model: carData.model,
        year: carData.year,
        price: carData.price,
        mileage: carData.mileage,
        color: carData.color,
        fuelType: carData.fuelType,
        transmission: carData.transmission,
        bodyType: carData.bodyType,
        seats: carData.seats,
        description: carData.description,
        status: carData.status,
        featured: carData.featured,
        images: imageUrls, // Store the array of image URLs
      },
    });

    // Revalidate the cars list page / Refresh cached data
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    throw new Error("Error adding car:" + error.message);
  }
}

export async function getCars(search = "") {
  try {
    // Authenticate user
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized!");

    // Verify user exists in database
    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    let where = {};

    if(search) {
      where.OR = [
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { color: { contains: search, mode: "insensitive" } },
      ];
    }

    const cars = await db.car.findMany({
      where,
      orderBy: { createdAt: "desc" },
    })

    const serializedCars = cars.map(serializeCarData);
    return {
      success: true,
      data: serializedCars,
    };
  } catch(error) {
    console.error("Error fetching cars:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function deleteCar(id) {
  try {
    // Authenticate user
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized!");

    // Verify user exists in database
    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    // First, fetch the car to get its images
    const car = await db.car.findUnique({
      where: { id },
      select: { images: true },
    });

    if (!car) {
      return {
        success: false,
        error: "Car not found",
      };
    }

    // Delete the car from the database
    await db.car.delete({
      where: { id },
    });

    try {
      const cookieStore = cookies();
      const supabase = createClient(cookieStore);

      const filePaths = car.images
        .map((imageUrl) => {
          const url = new URL(imageUrl);
          const pathMatch = url.pathname.match(/\/car-images\/(.*)/);
          return pathMatch ? pathMatch[1] : null;
        })
        .filter(Boolean);

      // Delete files from storage if paths were extracted
      if (filePaths.length > 0) {
        const { error } = await supabase.storage.from("car-images").remove(filePaths);

        if (error) {
          console.error("Error deleting images:", error);
          // We continue even if image deletion fails
        }
      }
    } catch (storageError) {
      console.error("Error with storage operations:", storageError);
      // Continue with the function even if storage operations fail
    }

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch(error) {
    console.error("Error deleting car:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

export async function updateCarStatus(id, {status, featured}) {
  try {
    // Authenticate user
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized!");

    // Verify user exists in database
    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });
    if (!user) throw new Error("User not found");

    const updateData = {};

    if (status !== undefined) {
      updateData.status = status;
    }

    if (featured !== undefined) {
      updateData.featured = featured;
    }

    // Update the car
    await db.car.update({
      where: { id },
      data: updateData,
    });

    // Revalidate the cars list page
    revalidatePath("/admin/cars");

    return {
      success: true,
    };
  } catch (error) {
    console.error("Error updating car status:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}
