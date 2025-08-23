const { MongoClient, ObjectId } = require('mongodb');
const cron = require('node-cron');
require('dotenv').config();

// MongoDB connection configuration
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;

if (!uri) {
    throw new Error('Please add your MongoDB URI to .env.local');
}

const options = {
    maxPoolSize: 10,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
};

let client;
let clientPromise;

if (process.env.NODE_ENV === 'development') {
    let globalWithMongo = global;
    if (!globalWithMongo._mongoClientPromise) {
        client = new MongoClient(uri, options);
        globalWithMongo._mongoClientPromise = client.connect();
    }
    clientPromise = globalWithMongo._mongoClientPromise;
} else {
    client = new MongoClient(uri, options);
    clientPromise = client.connect();
}

async function connectToDatabase() {
    try {
        const client = await clientPromise;
        const db = client.db(dbName);
        return { client, db };
    } catch (error) {
        console.error('Error connecting to database:', error);
        throw error;
    }
}

// Main tracking function
async function trackAllVehicles() {
    console.log(`[${new Date().toISOString()}] Starting vehicle tracking cron job...`);

    try {
        const { db } = await connectToDatabase();

        // Check what collections exist
        const collections = await db.listCollections().toArray();
        console.log('Available collections:', collections.map(col => col.name));

        // Get all vehicles that need tracking - using correct field names from your DB
        const vehicles = await db.collection('vehicles').find({
            $and: [
                {
                    $or: [
                        { driverContact: { $exists: true, $ne: null, $ne: "" } },
                        { registrationNumber: { $exists: true, $ne: null, $ne: "" } },
                        { phoneNumber: { $exists: true, $ne: null, $ne: "" } },
                        { vehicleNumber: { $exists: true, $ne: null, $ne: "" } }
                    ]
                },
                { "departureInfo.shippingType": "FTL" },
                { status: "in-transit" }
            ]
        }).toArray();

        console.log(`Found ${vehicles.length} vehicles to track`);

        // Log some details about found vehicles for debugging
        if (vehicles.length > 0) {
            console.log('Sample vehicles found:');
            vehicles.slice(0, 3).forEach((vehicle, index) => {
                console.log(`  ${index + 1}. ID: ${vehicle._id}, Registration: ${vehicle.registrationNumber || 'N/A'}, Contact: ${vehicle.driverContact || 'N/A'}`);
            });
        } else {
            console.log('No vehicles found with driverContact or registrationNumber fields');
            // Let's also check what fields exist in the collection
            const sampleVehicle = await db.collection('vehicles').findOne({});
            if (sampleVehicle) {
                console.log('Sample vehicle fields:', Object.keys(sampleVehicle));
            }
        }

        for (const vehicle of vehicles) {
            try {
                console.log(`Processing vehicle: ${vehicle.registrationNumber || vehicle._id}`);
                await trackSingleVehicle(vehicle, db);
            } catch (error) {
                console.error(`Error tracking vehicle ${vehicle._id}:`, error);
            }
        }

        console.log(`[${new Date().toISOString()}] Vehicle tracking cron job completed`);
    } catch (error) {
        console.error('Error in tracking cron job:', error);
    }
}

// New function to extract and store latest location in uniform locationHistory
async function updateLocationHistory() {
    console.log(`[${new Date().toISOString()}] Starting location history update...`);

    try {
        const { db } = await connectToDatabase();

        // Get all vehicles with departureInfo.shippingType
        const vehicles = await db.collection('vehicles').find({
            $and: [
                { "departureInfo.shippingType": "FTL" },
                { status: "in-transit" }
            ]
        }).toArray();
        console.log(`Processing ${vehicles.length} vehicles for location history update`);

        for (const vehicle of vehicles) {
            try {
                await extractAndStoreLatestLocation(vehicle, db);
            } catch (error) {
                console.error(`Error updating location history for vehicle ${vehicle._id}:`, error);
            }
        }

        console.log(`[${new Date().toISOString()}] Location history update completed`);
    } catch (error) {
        console.error('Error in location history update:', error);
    }
}

// Helper function to get place name from coordinates using reverse geocoding
async function getPlaceNameFromCoordinates(latitude, longitude) {
    try {
        // Using OpenStreetMap Nominatim API for reverse geocoding
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`,
            {
                headers: {
                    'User-Agent': 'VehicleTrackingApp/1.0'
                }
            }
        );

        if (response.ok) {
            const data = await response.json();
            if (data.display_name) {
                // Extract a shorter, more readable place name
                const parts = data.display_name.split(', ');
                if (parts.length >= 2) {
                    return `${parts[0]}, ${parts[1]}`; // City, State/Country
                }
                return data.display_name;
            }
        }
        return null;
    } catch (error) {
        console.error('Error in reverse geocoding:', error);
        return null;
    }
}

// Function to extract the latest location from SIM, FASTag, and manual, and store only the latest valid one
async function extractAndStoreLatestLocation(vehicle, db) {
    const vehicleId = vehicle._id.toString();
    const now = new Date();

    let candidates = [];
    let simLog = null, fastTagLog = null, manualLog = null;

    // 1. SIM Tracking API
    let simLocation = null;
    let simTimestamp = null;
    try {
        const phoneNumber = vehicle.driverContact || vehicle.phoneNumber || vehicle.contact || null;
        if (phoneNumber) {
            const simResult = await callSimTrackingAPI(phoneNumber);
            if (simResult.success && simResult.data && simResult.data.location) {
                let latitude, longitude, timestamp;
                if (Array.isArray(simResult.data.location)) {
                    longitude = simResult.data.location[0];
                    latitude = simResult.data.location[1];
                } else if (simResult.data.location.lat && simResult.data.location.lng) {
                    latitude = simResult.data.location.lat;
                    longitude = simResult.data.location.lng;
                }
                timestamp = simResult.data.timestamp || new Date().toISOString();
                simLog = { latitude, longitude, timestamp };
                if (latitude && longitude) {
                    // Get place name from coordinates
                    const placeName = await getPlaceNameFromCoordinates(latitude, longitude);
                    candidates.push({
                        latitude,
                        longitude,
                        placeName: placeName,
                        timestamp,
                        source: 'simTracking',
                        createdAt: now
                    });
                }
            } else {
                simLog = { latitude: null, longitude: null, timestamp: null };
            }
        }
    } catch (e) {
        simLog = { latitude: null, longitude: null, timestamp: null };
    }

    // 2. FASTag API
    try {
        const vehicleNumber = vehicle.registrationNumber || vehicle.vehicleNumber || vehicle.regNumber || null;
        if (vehicleNumber) {
            const fastTagResult = await callFastTagAPI(vehicleNumber);
            if (fastTagResult.success && fastTagResult.data && Array.isArray(fastTagResult.data) && fastTagResult.data.length > 0) {
                // Find the latest transaction with valid geocode
                const latestTxn = fastTagResult.data.reduce((latest, tx) => {
                    if (tx.tollPlazaGeocode && tx.readerReadTime) {
                        const [lat, lng] = tx.tollPlazaGeocode.split(',').map(Number);
                        if (!isNaN(lat) && !isNaN(lng)) {
                            if (!latest || new Date(tx.readerReadTime) > new Date(latest.readerReadTime)) {
                                return tx;
                            }
                        }
                    }
                    return latest;
                }, null);
                if (latestTxn && latestTxn.tollPlazaGeocode) {
                    const [lat, lng] = latestTxn.tollPlazaGeocode.split(',').map(Number);
                    fastTagLog = { latitude: lat, longitude: lng, timestamp: latestTxn.readerReadTime };
                    if (!isNaN(lat) && !isNaN(lng)) {
                        // Get place name from coordinates for FASTag too
                        const placeName = await getPlaceNameFromCoordinates(lat, lng);
                        candidates.push({
                            latitude: lat,
                            longitude: lng,
                            placeName: placeName,
                            timestamp: latestTxn.readerReadTime,
                            source: 'fastTag',
                            createdAt: now
                        });
                    }
                } else {
                    fastTagLog = { latitude: null, longitude: null, timestamp: null };
                }
            } else {
                fastTagLog = { latitude: null, longitude: null, timestamp: null };
            }
        }
    } catch (e) {
        fastTagLog = { latitude: null, longitude: null, timestamp: null };
    }

    // 3. Manual (from DB locations array)
    if (vehicle.locations && Array.isArray(vehicle.locations) && vehicle.locations.length > 0) {
        // Find the latest valid manual location
        const manualLatest = [...vehicle.locations].reverse().find(loc => (loc.lat || loc.latitude) && (loc.lng || loc.longitude) && (loc.updatedAt || loc.timestamp));
        if (manualLatest) {
            manualLog = {
                latitude: manualLatest.lat || manualLatest.latitude,
                longitude: manualLatest.lng || manualLatest.longitude,
                timestamp: manualLatest.updatedAt || manualLatest.timestamp
            };
            // Get place name from coordinates for manual location too
            const placeName = await getPlaceNameFromCoordinates(manualLog.latitude, manualLog.longitude);
            candidates.push({
                latitude: manualLatest.lat || manualLatest.latitude,
                longitude: manualLatest.lng || manualLatest.longitude,
                placeName: placeName,
                timestamp: manualLatest.updatedAt || manualLatest.timestamp,
                source: 'manual',
                createdAt: now
            });
        } else {
            manualLog = { latitude: null, longitude: null, timestamp: null };
        }
    } else {
        manualLog = { latitude: null, longitude: null, timestamp: null };
    }

    // Print all three logs
    console.log(`Vehicle ${vehicleId} - SIM:`, simLog);
    console.log(`Vehicle ${vehicleId} - FASTag:`, fastTagLog);
    console.log(`Vehicle ${vehicleId} - Manual:`, manualLog);

    // Pick the latest valid one by timestamp
    const validCandidates = candidates.filter(c => c.latitude && c.longitude && c.timestamp);
    if (validCandidates.length > 0) {
        validCandidates.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const latest = validCandidates[0];
        console.log(`Vehicle ${vehicleId} - Chosen for locationHistory:`, latest);
        await db.collection('vehicles').updateOne(
            { _id: new ObjectId(vehicleId) },
            {
                $push: {
                    locationHistory: latest
                },
                $currentDate: {
                    updatedAt: { $type: "date" }
                }
            }
        );
        console.log(`Updated location history for vehicle ${vehicleId} with ${latest.source} location from ${latest.timestamp}`);
    } else {
        console.log(`No valid location found for vehicle ${vehicleId}, skipping.`);
    }
}

async function trackSingleVehicle(vehicle, db) {
    const { vehicleId, phoneNumber, vehicleNumber } = {
        vehicleId: vehicle._id.toString(),
        phoneNumber: vehicle.driverContact || vehicle.phoneNumber || vehicle.contact || null, // Try multiple possible field names
        vehicleNumber: vehicle.registrationNumber || vehicle.vehicleNumber || vehicle.regNumber || null // Try multiple possible field names
    };

    if (!phoneNumber && !vehicleNumber) {
        console.log(`Skipping vehicle ${vehicleId} - no phone number or vehicle number found`);
        console.log(`Available fields: ${Object.keys(vehicle).join(', ')}`);
        return;
    }

    console.log(`Track Location API called for vehicle:`, { vehicleId, phoneNumber, vehicleNumber });

    // Call both APIs in parallel (only if we have the required data)
    const promises = [];

    if (phoneNumber) {
        promises.push(callSimTrackingAPI(phoneNumber).catch(error => {
            console.error(`SIM tracking failed for ${phoneNumber}:`, error.message);
            return { success: false, error: error.message };
        }));
    } else {
        promises.push(Promise.resolve({ success: false, error: 'No phone number' }));
    }

    if (vehicleNumber) {
        promises.push(callFastTagAPI(vehicleNumber).catch(error => {
            console.error(`FastTag tracking failed for ${vehicleNumber}:`, error.message);
            return { success: false, error: error.message };
        }));
    } else {
        promises.push(Promise.resolve({ success: false, error: 'No vehicle number' }));
    }

    const [simTrackingResult, fastTagResult] = await Promise.all(promises);

    // Extract Update Location data (most recent from locations array)
    let updateLocationData = null;
    let updateLocationTimestamp = null;

    // Check for locations in the vehicle document - handle different possible field names
    const locationsArray = vehicle.locations || vehicle.locationHistory || vehicle.updateLocations || [];

    if (Array.isArray(locationsArray) && locationsArray.length > 0) {
        const mostRecentLocation = locationsArray[locationsArray.length - 1];
        if (mostRecentLocation && (mostRecentLocation.lat || mostRecentLocation.latitude) && (mostRecentLocation.lng || mostRecentLocation.longitude)) {
            updateLocationData = {
                location: {
                    lat: mostRecentLocation.lat || mostRecentLocation.latitude,
                    lng: mostRecentLocation.lng || mostRecentLocation.longitude
                },
                placeName: mostRecentLocation.placeName || mostRecentLocation.place || null,
                timestamp: mostRecentLocation.updatedAt || mostRecentLocation.timestamp || new Date().toISOString()
            };
            updateLocationTimestamp = updateLocationData.timestamp;
        }
    }

    // Process SIM Tracking result
    let simLocation = null;
    let simTimestamp = null;
    let simStatus = 'failed';

    if (simTrackingResult.success) {
        const simData = simTrackingResult.data;
        if (simData?.location) {
            let latitude, longitude;

            if (Array.isArray(simData.location)) {
                longitude = simData.location[0];
                latitude = simData.location[1];
            } else if (simData.location.lat && simData.location.lng) {
                latitude = simData.location.lat;
                longitude = simData.location.lng;
            }

            if (latitude && longitude) {
                simLocation = { lat: latitude, lng: longitude };
                simTimestamp = simData.timestamp || new Date().toISOString();
                simStatus = 'success';
            }
        }
    }

    // Process FASTag result
    let fastTagLocation = null;
    let fastTagTimestamp = null;
    let fastTagStatus = 'failed';

    if (fastTagResult.success) {
        const fastTagData = fastTagResult;
        if (fastTagData.data && Array.isArray(fastTagData.data) && fastTagData.data.length > 0) {
            const latestTransaction = fastTagData.data[fastTagData.data.length - 1];
            if (latestTransaction.tollPlazaGeocode) {
                const [lat, lng] = latestTransaction.tollPlazaGeocode.split(',').map(Number);
                if (!isNaN(lat) && !isNaN(lng)) {
                    fastTagLocation = { lat, lng };
                    fastTagTimestamp = latestTransaction.readerReadTime || new Date().toISOString();
                    fastTagStatus = 'success';
                }
            }
        }
    }

    // Save tracking data to database
    await saveToDatabase(vehicleId, {
        simTracking: {
            location: simLocation,
            timestamp: simTimestamp,
            status: simStatus,
            rawResponse: simTrackingResult.success ? simTrackingResult : null
        },
        fastTag: {
            location: fastTagLocation,
            timestamp: fastTagTimestamp,
            status: fastTagStatus,
            rawResponse: fastTagResult.success ? fastTagResult : null
        },
        updateLocation: updateLocationData
    }, db);

    console.log(`Completed tracking for vehicle ${vehicleId}`);
}

async function callSimTrackingAPI(phoneNumber) {
    const authkey = "Pai0Ffn10MElRrlkPQk1VsGJk1";

    // Helper to call location API
    const getLocation = async () => {
        const locationResponse = await fetch(
            "https://track.cxipl.com/api/v2/phone-tracking/location",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    authkey: authkey,
                },
                body: JSON.stringify({ phoneNumber }),
            }
        );
        const locationData = await locationResponse.json();
        console.log('SIM Location Response:', locationData);
        return { ok: locationResponse.ok, body: locationData };
    };

    // 1) Try to fetch location directly first (avoid sending SMS if already allowed)
    try {
        const firstTry = await getLocation();
        if (firstTry.ok && firstTry.body && firstTry.body.success) {
            return firstTry.body;
        }
    } catch (e) {
        // ignore and fall through to subscription flow
    }

    // 2) If direct location failed, subscribe then retry location
    const subscribeResponse = await fetch(
        "https://track.cxipl.com/api/v2/phone-tracking/subscribe",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                authkey: authkey,
            },
            body: JSON.stringify({
                phoneNumber,
                carrier: "airtel",
                vehicleNumber: "PENDING",
                transDocNumber: Date.now().toString(),
            }),
        }
    );

    const subscribeData = await subscribeResponse.json();
    console.log('SIM Tracking Subscribe Response:', subscribeData);

    if (!subscribeData.success) {
        throw new Error(subscribeData.message || 'Failed to subscribe for SIM tracking');
    }

    // Wait a bit for the subscription to take effect
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 3) Retry location after subscribe
    const secondTry = await getLocation();
    if (!secondTry.body || !secondTry.body.success) {
        throw new Error(secondTry.body?.message || 'Failed to get SIM location');
    }

    return secondTry.body;
}

async function callFastTagAPI(vehicleNumber) {
    const apiUrl = "https://bot.scmapml.com/verify/fastag";
    const payload = JSON.stringify({ vehiclenumber: vehicleNumber });
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    // Temporarily disable SSL verification for development
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: payload,
        });

        const data = await response.json();
        console.log('FastTag API Response:', data);

        if (!response.ok) {
            throw new Error(`FastTag API responded with status: ${response.status}`);
        }

        if (data.code !== '200' || data.error === 'true') {
            throw new Error(data.message || 'Failed to fetch FastTag data');
        }

        // Process the response to extract transaction data
        let processedTransactions = [];

        if (data.response && Array.isArray(data.response) && data.response.length > 0) {
            const firstResponse = data.response[0];

            if (firstResponse.response && firstResponse.response.vehicle && firstResponse.response.vehicle.vehltxnList) {
                const txnList = firstResponse.response.vehicle.vehltxnList.txn;

                if (Array.isArray(txnList) && txnList.length > 0) {
                    processedTransactions = txnList.map((tx) => {
                        if (!tx.tollPlazaGeocode && tx.tollPlazaLatitude && tx.tollPlazaLongitude) {
                            tx.tollPlazaGeocode = `${tx.tollPlazaLatitude},${tx.tollPlazaLongitude}`;
                        }
                        return tx;
                    });
                }
            }
        }

        return {
            success: true,
            data: processedTransactions,
            transactionsCount: processedTransactions.length
        };

    } finally {
        // Reset SSL verification
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    }
}

async function saveToDatabase(vehicleId, trackingData, db) {
    try {
        const now = new Date();
        const updateDocument = {
            $set: {
                trackLocationLastUpdated: now
            },
            $currentDate: {
                updatedAt: { $type: "date" }
            }
        };

        // Only store in locationHistory, not in separate arrays
        const locationHistoryEntries = [];

        // Update SIM tracking data if available
        if (trackingData.simTracking.location) {
            updateDocument.$set.simTracking = {
                location: trackingData.simTracking.location,
                timestamp: trackingData.simTracking.timestamp,
                status: trackingData.simTracking.status
            };

            // Add to locationHistory instead of simTrackingLocations
            locationHistoryEntries.push({
                latitude: trackingData.simTracking.location.lat,
                longitude: trackingData.simTracking.location.lng,
                timestamp: trackingData.simTracking.timestamp,
                source: 'simTracking',
                placeName: null, // Will be populated by reverse geocoding in location history cron
                createdAt: now
            });
        }

        // Update FASTag data if available
        if (trackingData.fastTag.location) {
            updateDocument.$set.fasttagLastUpdated = now;
            updateDocument.$set.fasttagStatus = 'success';

            // Add to locationHistory
            locationHistoryEntries.push({
                latitude: trackingData.fastTag.location.lat,
                longitude: trackingData.fastTag.location.lng,
                timestamp: trackingData.fastTag.timestamp,
                source: 'fastTag',
                placeName: null, // Will be populated by reverse geocoding in location history cron
                createdAt: now
            });
        }

        // Update Update Location data if available
        if (trackingData.updateLocation?.location) {
            // Add to locationHistory instead of updateLocations
            locationHistoryEntries.push({
                latitude: trackingData.updateLocation.location.lat,
                longitude: trackingData.updateLocation.location.lng,
                timestamp: trackingData.updateLocation.timestamp,
                source: 'manual',
                placeName: trackingData.updateLocation.placeName,
                createdAt: now
            });
        }

        // Only add to locationHistory if we have valid location data
        if (locationHistoryEntries.length > 0) {
            updateDocument.$push = {
                locationHistory: { $each: locationHistoryEntries }
            };
        }

        // Update the vehicle document
        await db.collection('vehicles').updateOne(
            { _id: new ObjectId(vehicleId) },
            updateDocument
        );

        console.log(`Track Location: Data saved to database for vehicle ${vehicleId}`);
    } catch (error) {
        console.error('Error saving track location data to database:', error);
        throw error;
    }
}

// Helper function to format time difference
function formatTimeDifference(diffMs) {
    const absDiff = Math.abs(diffMs);
    const minutes = Math.floor(absDiff / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days} day${days > 1 ? 's' : ''} ago`;
    } else if (hours > 0) {
        return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else if (minutes > 0) {
        return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else {
        return 'Just now';
    }
}

// Start the cron job
console.log('Starting vehicle tracking cron job...');

// Schedule the tracking job to run every 4 hours instead of every minute
const trackingCronJob = cron.schedule('0 */4 * * *', async () => {
    await trackAllVehicles();
}, {
    scheduled: false,
    timezone: "Asia/Kolkata" // Adjust timezone as needed
});

// Schedule the location history update job to run ever*/30 * * * * *y 4 hours
const locationHistoryCronJob = cron.schedule('0 */4 * * *', async () => {
    await updateLocationHistory();
}, {
    scheduled: false,
    timezone: "Asia/Kolkata" // Adjust timezone as needed
});

// Start both cron jobs
trackingCronJob.start();
locationHistoryCronJob.start();

console.log('Vehicle tracking cron job scheduled to run every 4 hours');
console.log('Location history update cron job scheduled to run every 4 hours');

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('Stopping vehicle tracking cron jobs...');
    trackingCronJob.stop();
    locationHistoryCronJob.stop();
    if (client) {
        await client.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Stopping vehicle tracking cron jobs...');
    trackingCronJob.stop();
    locationHistoryCronJob.stop();
    if (client) {
        await client.close();
    }
    process.exit(0);
});

// Export for testing purposes
module.exports = {
    trackAllVehicles,
    trackSingleVehicle,
    callSimTrackingAPI,
    callFastTagAPI,
    saveToDatabase,
    updateLocationHistory,
    extractAndStoreLatestLocation
};
