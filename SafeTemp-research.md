# SafeTemp — Research & Drafts

Prepared with help from Claude (AI). Everything in this file must be listed in your AI disclosure.
You still build the screens and the risk rules yourself.

---

## 1. Weather data (Open-Meteo — free, no account, no key)

Paste this link into your App Inventor `Web` block's Url. Replace LAT and LON with the
phone's location (from the `LocationSensor` block):

```
https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&current=apparent_temperature&daily=apparent_temperature_max,apparent_temperature_min&temperature_unit=fahrenheit&timezone=auto&forecast_days=7
```

Tested live on 2026-10-19 (New York). Example of what comes back:

```
"current": { "apparent_temperature": 55.8 }
"daily": {
  "time": ["2026-10-19", "2026-10-20", ...7 days],
  "apparent_temperature_max": [60.1, 60.5, ...],   <- hottest "feels like" each day
  "apparent_temperature_min": [38.2, 37.8, ...]    <- coldest "feels like" each day
}
```

- **apparent_temperature** = "feels like" temperature (includes humidity in heat, wind in cold).
- Use **max** to check heat danger, **min** to check cold danger.
- Note for your video/README: Open-Meteo's "feels like" is close to, but not identical to,
  the NWS heat index and wind chill. Say "based on feels-like temperature."

---

## 2. Official charts — YOU pick the numbers for your rules from these

### Heat — National Weather Service heat index categories
| Feels like (°F) | NWS category | What can happen |
|---|---|---|
| 80–90 | Caution | Fatigue possible with long exposure/activity |
| 90–103 | Extreme Caution | Heat cramps and heat exhaustion possible |
| 103–124 | Danger | Heat cramps/exhaustion likely; heat stroke possible |
| 125+ | Extreme Danger | Heat stroke highly likely |

Source: https://www.weather.gov/safety/heat-index

### Cold — National Weather Service wind chill chart
- Around **-18°F** wind chill: frostbite possible on exposed skin in **~30 minutes**
- Around **-35°F**: frostbite in **~10 minutes**
- Around **-48°F**: frostbite in **~5 minutes**
- Hypothermia risk rises well above these temperatures, especially for seniors and babies.

Source: https://www.weather.gov/safety/cold-wind-chill-chart (check exact values on the chart)

### Your decisions (fill these in yourself — this is YOUR logic)
- Should a **senior or baby** get a higher risk level than a healthy adult at the same temperature?
  (CDC says older adults, young children, and people with chronic illness are at higher risk.)
- Heat: Safe below ___ / Caution ___ / Danger ___ / Extreme ___
- Cold: Safe above ___ / Caution ___ / Danger ___ / Extreme ___

---

## 3. Safety advice drafts — EDIT THESE into your own words

Based on CDC and NWS guidance. Three actions per type per condition.

### Senior (65+)
- Heat: Stay in air conditioning during the hottest hours (12–6 PM). If you don't have AC, go to a cooling center or library. Drink water even if you're not thirsty. Ask someone to check on you twice a day.
- Cold: Keep your home at least 68°F. Wear layers and a hat indoors if it's cold. Never use an oven or grill to heat your home (carbon monoxide risk).

### Outdoor worker
- Heat: Drink a cup of water every 15–20 minutes. Take breaks in the shade. Know the signs of heat stroke: confusion, hot dry skin, fainting. Call 911.
- Cold: Wear layers, a hat, gloves and waterproof boots. Take warm breaks indoors. Watch for numb or white skin (frostbite).

### Athlete / student athlete
- Heat: Move practice to early morning or evening. Take water breaks every 15–20 minutes. Stop immediately if dizzy, nauseous or confused.
- Cold: Warm up indoors. Cover your head, ears and hands. Change out of sweaty clothes right after practice.

### Parent of a baby or young child
- Heat: **Never leave a child in a car**, not even for a minute. Keep them in shade or AC. Dress them in light, loose clothes.
- Cold: Dress babies in one more layer than an adult would wear. No loose blankets in the crib. Limit time outside.

### Person with a health condition (heart, lung, diabetes, etc.)
- Heat: Some medicines make heat more dangerous — ask your doctor or pharmacist. Stay in AC. Have someone check on you.
- Cold: Cold strains the heart, so avoid shoveling snow or heavy outdoor work. Keep needed medicine and supplies at home in case of storms.

Sources: https://www.cdc.gov/heat-health/ and https://www.cdc.gov/winter-weather/

---

## 4. Supplies checklist — "Do you have what you need?"

The app asks "Do you have these?" and the user taps ✔ or ✘. Based on CDC and Ready.gov guidance.
EDIT these: cut any you don't want, keep each list short (5–6 items).

### Heat — everyone
- Water (at least 1 gallon per person per day)
- Air conditioning, or a fan + a cool place to go
- Light, loose, light-colored clothes
- Hat and sunscreen (SPF 15+)
- Cooling items: wet towel, spray bottle, ice packs

### Cold — everyone
- Warm winter jacket
- Hat, gloves, scarf
- Warm, waterproof shoes or boots
- Extra blankets
- Safe heat source (working heater; never an oven or grill)

### Extras by type
- **Senior / health condition:** a week of medicine; a phone charger or power bank; flashlight (in case the power goes out)
- **Outdoor worker / athlete:** refillable water bottle; electrolyte drinks; cooling towel (heat) or hand warmers + thermal layers (cold)
- **Baby / young child:** extra baby formula or water; extra layers and a warm hat for the baby (cold); light clothes + a shade cover for the stroller (heat)

### If they tap ✘ (missing an item)
Show "Where to get it" instead of a store link:
- **Water / cooling:** go to a cooling center (list in section 5)
- **Jacket / blankets:** free coat drives and shelters — call **211** to find one near you
- **Can't afford AC/heating bills:** LIHEAP (section 5)
- Optional: a "buy it" link as a last option (your call; judges may see store links as ads)

Sources: https://www.cdc.gov/heat-health/ , https://www.cdc.gov/winter-weather/ , https://www.ready.gov/kit

---

## 5. "Get help" — free resources

State: **California**

- **LIHEAP in California** (help paying heating AND cooling bills, plus emergency help if your
  power is about to be shut off). Run by the CA Dept. of Community Services and Development (CSD).
  Find your local provider by city/county: https://www.csd.ca.gov/energybills
- **Cal OES cooling centers list** (statewide, organized by county; check it's current):
  https://news.caloes.ca.gov/coolingcenters/
- **Listos California** extreme heat tips (state emergency preparedness): https://www.listoscalifornia.org/
- **Call 211** — free, 24/7 line that connects people to local help, including cooling and warming centers.
- **Local cooling/warming centers**: TODO. Tell Claude your county to fill in 3–5 specific places.

---

## 6. AI-use log (for your disclosure — keep adding as you go)

- Claude researched the weather data service and tested the link.
- Claude summarized the NWS heat index and wind chill charts.
- Claude drafted the safety advice text (you edited it into your own words).
- Claude drafted the supplies checklist (heat, cold, and extras by type).
- Claude wrote the App Inventor blocks for: getting the phone's location, fetching the weather from Open-Meteo and reading the "feels like" temperature, and the Warn family text button (SafeTemp_v2.aia). The empty CheckRisk block was left for me to fill in with my own risk rules.
- Claude compiled the free help resources (California: CSD LIHEAP, Cal OES cooling centers, Listos California, 211).
