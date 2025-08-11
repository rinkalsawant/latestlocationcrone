const { MongoClient } = require("mongodb");

const uri = "mongodb://localhost:27017"; // Replace with your Mongo URI
const dbName = "gate_management";                 // Replace with your DB name
const collectionName = "vehicles"; // Replace with your collection name

async function transformLocations() {
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        const documents = await collection.find({}).toArray();
        const results = [];

        for (const doc of documents) {
            const uniformLocations = [];

            // 1. simTrackingLocations
            if (Array.isArray(doc.simTrackingLocations) && doc.simTrackingLocations.length > 0) {
                for (const sim of doc.simTrackingLocations) {
                    if (sim.location?.lat && sim.location?.lng) {
                        uniformLocations.push({
                            latitude: sim.location.lat,
                            longitude: sim.location.lng,
                            placeName: null,
                            timestamp: sim.timestamp || sim.createdAt || null,
                            source: "simTrackingLocations"
                        });
                    }
                }
            }

            // 2. fasttagTransactions
            if (Array.isArray(doc.fasttagTransactions) && doc.fasttagTransactions.length > 0) {
                const rawResponses = doc.fasttagTransactions[0]?.rawResponse || [];
                for (const raw of rawResponses) {
                    const fastTagData = raw.data || [];
                    for (const ft of fastTagData) {
                        if (ft.tollPlazaGeocode) {
                            const [latStr, lngStr] = ft.tollPlazaGeocode.split(",");
                            const lat = parseFloat(latStr);
                            const lng = parseFloat(lngStr);
                            if (!isNaN(lat) && !isNaN(lng)) {
                                uniformLocations.push({
                                    latitude: lat,
                                    longitude: lng,
                                    placeName: ft.tollPlazaName || null,
                                    timestamp: ft.readerReadTime || null,
                                    source: "fasttagTransactions"
                                });
                            }
                        }
                    }
                }
            }

            // 3. manual locations
            if (Array.isArray(doc.locations) && doc.locations.length > 0) {
                for (const loc of doc.locations) {
                    if (loc.lat && loc.lng) {
                        uniformLocations.push({
                            latitude: loc.lat,
                            longitude: loc.lng,
                            placeName: loc.placeName || null,
                            timestamp: loc.updatedAt || null,
                            source: "manualLocation"
                        });
                    }
                }
            }

            // Add all extracted locations
            results.push(...uniformLocations);
        }

        console.log("✅ Uniform Locations:");
        console.log(JSON.stringify(results, null, 2));

    } catch (err) {
        console.error("❌ Error:", err);
    } finally {
        await client.close();
    }
}

transformLocations();
