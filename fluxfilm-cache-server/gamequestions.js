/**
 * FluxFilm Games - starter questions drafted by Claude (2026-09-15) for the owner to review in admin → 🎮 Games.
 * Written from public facts (no copied text, no TMDB data). Answer = the FIRST option; the server shuffles options.
 *
 * QUIZ : [question, correct, wrong, wrong, wrong, category]
 * EMOJI: [emojis, title, category]  - wrong options are other titles from the same category.
 *
 * Used when the quiz_questions table is empty (or not created yet) and by the "Load starter pack" admin button.
 */
const QUIZ = [
  // Indian films
  ['Which film features the Oscar-winning song "Naatu Naatu"?', 'RRR', 'Baahubali 2', 'Pushpa: The Rise', 'KGF Chapter 2', 'bollywood'],
  ['In "3 Idiots", what do friends call Aamir Khan\'s character?', 'Rancho', 'Raju', 'Farhan', 'Virus', 'bollywood'],
  ['"Mogambo khush hua" is a famous line from which film?', 'Mr. India', 'Sholay', 'Don', 'Karan Arjun', 'bollywood'],
  ['Who directed "Baahubali: The Beginning"?', 'S. S. Rajamouli', 'Prashanth Neel', 'Shankar', 'Sukumar', 'bollywood'],
  ['In "Sholay", what is the name of the villain played by Amjad Khan?', 'Gabbar Singh', 'Mogambo', 'Shakaal', 'Kancha Cheena', 'bollywood'],
  ['Which film has the famous line "How\'s the josh?"', 'Uri: The Surgical Strike', 'Border', 'Shershaah', 'Lakshya', 'bollywood'],
  ['Who plays the title role in "Pushpa: The Rise"?', 'Allu Arjun', 'Ram Charan', 'Prabhas', 'Yash', 'bollywood'],
  ['What is the name of Yash\'s character in the KGF films?', 'Rocky', 'Pushpa', 'Bhalla', 'Vikram', 'bollywood'],
  ['In which 1995 film do Raj and Simran fall in love on a trip across Europe?', 'Dilwale Dulhania Le Jayenge', 'Kuch Kuch Hota Hai', 'Kabhi Khushi Kabhie Gham', 'Dil To Pagal Hai', 'bollywood'],
  ['The horror-comedy "Stree" is set in which town?', 'Chanderi', 'Bhopal', 'Gwalior', 'Orchha', 'bollywood'],
  ['Which film introduced the cop character Chulbul Pandey?', 'Dabangg', 'Singham', 'Simmba', 'Rowdy Rathore', 'bollywood'],
  ['"Aata majhi satakli" is the catchphrase of which cop?', 'Bajirao Singham', 'Chulbul Pandey', 'Sangram Bhalerao', 'Veer Sooryavanshi', 'bollywood'],
  ['"Gully Boy" is inspired by which music scene?', 'Mumbai street rap', 'Delhi Sufi music', 'Punjabi pop', 'Goa trance', 'bollywood'],
  ['"Kantara" was originally made in which language?', 'Kannada', 'Tamil', 'Telugu', 'Malayalam', 'bollywood'],
  ['The Hindi film "Drishyam" (2015) is a remake of a film first made in which language?', 'Malayalam', 'Tamil', 'Telugu', 'Kannada', 'bollywood'],
  ['Which superstar leads the 2023 film "Jailer"?', 'Rajinikanth', 'Kamal Haasan', 'Vijay', 'Mohanlal', 'bollywood'],
  ['Who plays the title character in "Vikram" (2022)?', 'Kamal Haasan', 'Rajinikanth', 'Suriya', 'Vijay Sethupathi', 'bollywood'],
  ['Who directed the series "Heeramandi"?', 'Sanjay Leela Bhansali', 'Karan Johar', 'Zoya Akhtar', 'Anurag Kashyap', 'bollywood'],
  ['In "Andhadhun", Ayushmann Khurrana\'s character pretends to be…', 'Blind', 'Deaf', 'A ghost', 'A police officer', 'bollywood'],
  ['"Mission Mangal" is about India\'s mission to which planet?', 'Mars', 'Venus', 'Jupiter', 'The Moon', 'bollywood'],
  // Indian web series
  ['Who plays Kaleen Bhaiya in "Mirzapur"?', 'Pankaj Tripathi', 'Nawazuddin Siddiqui', 'Manoj Bajpayee', 'Ali Fazal', 'series'],
  ['What is Manoj Bajpayee\'s character called in "The Family Man"?', 'Srikant Tiwari', 'JK Talpade', 'Guru Pandit', 'Sartaj Singh', 'series'],
  ['In "Sacred Games", Saif Ali Khan plays which police officer?', 'Sartaj Singh', 'Ganesh Gaitonde', 'Srikant Tiwari', 'Hathi Ram Chaudhary', 'series'],
  ['Which TVF series is set among IIT-JEE students in a coaching town?', 'Kota Factory', 'Aspirants', 'Panchayat', 'Gullak', 'series'],
  ['In "Panchayat", Abhishek Tripathi works in which village?', 'Phulera', 'Mirzapur', 'Sultanpur', 'Bhootpur', 'series'],
  ['"Scam 1992" tells the story of which stockbroker?', 'Harshad Mehta', 'Ketan Parekh', 'Nirav Modi', 'Vijay Mallya', 'series'],
  ['"Aspirants" follows students preparing for which exam?', 'UPSC', 'IIT-JEE', 'NEET', 'CAT', 'series'],
  ['"Gullak" is about the everyday life of which family?', 'The Mishra family', 'The Sharma family', 'The Tiwari family', 'The Gupta family', 'series'],
  ['"Made in Heaven" follows a business that plans…', 'Weddings', 'Restaurants', 'Detective cases', 'Fashion shows', 'series'],
  ['In "Farzi", Shahid Kapoor\'s character gets into making fake…', 'Currency notes', 'Passports', 'Medicines', 'Cricket tickets', 'series'],
  ['"Rocket Boys" is about Homi J. Bhabha and which scientist?', 'Vikram Sarabhai', 'A. P. J. Abdul Kalam', 'C. V. Raman', 'Satish Dhawan', 'series'],
  ['In "Delhi Crime" (season 1), Shefali Shah plays DCP…', 'Vartika Chaturvedi', 'Neeti Singh', 'Vimla Bharadwaj', 'Latika Sharma', 'series'],
  // Global series & films
  ['In "Money Heist", what name does the mastermind go by?', 'The Professor', 'The Doctor', 'The General', 'The Captain', 'series'],
  ['Which country is the series "Dark" set in?', 'Germany', 'Norway', 'Denmark', 'Austria', 'series'],
  ['Which of these is NOT a honeycomb candy shape in "Squid Game"?', 'Heart', 'Circle', 'Star', 'Umbrella', 'series'],
  ['"Stranger Things" is set in which fictional town?', 'Hawkins', 'Derry', 'Riverdale', 'Springfield', 'series'],
  ['In "Breaking Bad", what alias does Walter White use?', 'Heisenberg', 'Scarface', 'The Chemist', 'Blue Sky', 'series'],
  ['"Winter is coming" is the motto of which house in "Game of Thrones"?', 'Stark', 'Lannister', 'Targaryen', 'Baratheon', 'series'],
  ['What is the coffee shop called in "Friends"?', 'Central Perk', 'Monk\'s Café', 'MacLaren\'s', 'The Max', 'series'],
  ['"Money Heist" was originally made in which language?', 'Spanish', 'Italian', 'Portuguese', 'French', 'series'],
  ['"The Crown" is about the reign of which monarch?', 'Queen Elizabeth II', 'Queen Victoria', 'Queen Elizabeth I', 'Queen Mary', 'series'],
  ['Which school does Wednesday Addams attend in "Wednesday"?', 'Nevermore Academy', 'Hogwarts', 'Riverdale High', 'Hawkins Middle School', 'series'],
  ['"Peaky Blinders" is set in which English city?', 'Birmingham', 'London', 'Manchester', 'Liverpool', 'series'],
  ['What is the paper company called in the US version of "The Office"?', 'Dunder Mifflin', 'Sterling Cooper', 'Wernham Hogg', 'Pied Piper', 'series'],
  ['Who plays Sherlock Holmes in the BBC series "Sherlock"?', 'Benedict Cumberbatch', 'Martin Freeman', 'Tom Hiddleston', 'Matt Smith', 'series'],
  ['"House of the Dragon" is a prequel to which series?', 'Game of Thrones', 'The Witcher', 'The Lord of the Rings', 'Vikings', 'series'],
  ['In "The Boys", who leads the superhero team The Seven?', 'Homelander', 'Billy Butcher', 'Starlight', 'The Deep', 'series'],
  ['"Bridgerton" is set in which period?', 'Regency-era London', 'Victorian London', 'Tudor England', '1920s New York', 'series'],
  ['In "Harry Potter", which house is Harry sorted into?', 'Gryffindor', 'Slytherin', 'Ravenclaw', 'Hufflepuff', 'hollywood'],
  ['Which superhero is the king of Wakanda?', 'Black Panther', 'Doctor Strange', 'Thor', 'Captain Marvel', 'hollywood'],
  ['What is Iron Man\'s real name?', 'Tony Stark', 'Steve Rogers', 'Bruce Banner', 'Peter Parker', 'hollywood'],
  ['Who directed "Titanic" (1997)?', 'James Cameron', 'Steven Spielberg', 'Christopher Nolan', 'Ridley Scott', 'hollywood'],
  ['Which 2023 Christopher Nolan film is about the atomic bomb?', 'Oppenheimer', 'Tenet', 'Dunkirk', 'Interstellar', 'hollywood'],
  ['In "Frozen", what is Elsa\'s sister called?', 'Anna', 'Moana', 'Belle', 'Rapunzel', 'hollywood'],
  ['In "The Lion King", who is Simba\'s father?', 'Mufasa', 'Scar', 'Rafiki', 'Zazu', 'hollywood'],
  ['What is the cowboy toy called in "Toy Story"?', 'Woody', 'Buzz', 'Rex', 'Hamm', 'hollywood'],
  ['What does Grogu get nicknamed by fans of "The Mandalorian"?', 'Baby Yoda', 'Little Chewie', 'Mini Vader', 'Jedi Junior', 'hollywood'],
  ['Who plays Ken in "Barbie" (2023)?', 'Ryan Gosling', 'Ryan Reynolds', 'Chris Evans', 'Zac Efron', 'hollywood'],
  ['In "Finding Nemo", what kind of fish is Nemo?', 'Clownfish', 'Blue tang', 'Pufferfish', 'Goldfish', 'hollywood'],
  ['What is Spider-Man Peter Parker\'s aunt called?', 'May', 'Martha', 'Mary', 'Maggie', 'hollywood'],
  ['In "The Matrix", which pill does Neo take?', 'The red pill', 'The blue pill', 'The green pill', 'The white pill', 'hollywood'],
  ['What is the name of the robot in "Interstellar"?', 'TARS', 'HAL 9000', 'WALL-E', 'R2-D2', 'hollywood'],
  ['On which moon does "Avatar" take place?', 'Pandora', 'Arrakis', 'Tatooine', 'Krypton', 'hollywood'],
  ['What is the desert planet in "Dune" called?', 'Arrakis', 'Pandora', 'Tatooine', 'Jakku', 'hollywood'],
  ['What is Superman\'s home planet?', 'Krypton', 'Asgard', 'Titan', 'Xandar', 'hollywood'],
  ['Which South Korean film won the Oscar for Best Picture (2020)?', 'Parasite', 'Oldboy', 'Train to Busan', 'Minari', 'hollywood'],
  // Anime & cartoons
  ['Which studio made the anime "Demon Slayer"?', 'Ufotable', 'MAPPA', 'Toei Animation', 'Bones', 'anime'],
  ['Naruto grows up in which village?', 'The Hidden Leaf Village', 'The Hidden Sand Village', 'The Hidden Mist Village', 'The Hidden Cloud Village', 'anime'],
  ['In "One Piece", what is Luffy\'s dream?', 'To become King of the Pirates', 'To become Hokage', 'To become a Hunter', 'To defeat all demons', 'anime'],
  ['What is Eren\'s surname in "Attack on Titan"?', 'Yeager', 'Ackerman', 'Arlert', 'Braun', 'anime'],
  ['What is Goku\'s Saiyan birth name in "Dragon Ball"?', 'Kakarot', 'Vegeta', 'Raditz', 'Bardock', 'anime'],
  ['In "Death Note", who finds the notebook?', 'Light Yagami', 'L', 'Ryuk', 'Near', 'anime'],
  ['In "Jujutsu Kaisen", who swallows Sukuna\'s finger?', 'Yuji Itadori', 'Megumi Fushiguro', 'Satoru Gojo', 'Nobara Kugisaki', 'anime'],
  ['Which studio made "Spirited Away"?', 'Studio Ghibli', 'Toei Animation', 'MAPPA', 'Madhouse', 'anime'],
  ['Doraemon travels back in time from which century?', 'The 22nd century', 'The 21st century', 'The 23rd century', 'The 30th century', 'anime'],
  ['What is Shinchan\'s family name?', 'Nohara', 'Nobi', 'Uzumaki', 'Kamado', 'anime'],
  ['In "Demon Slayer", who is Tanjiro\'s sister?', 'Nezuko', 'Mitsuri', 'Shinobu', 'Kanao', 'anime'],
  ['What is Deku\'s real name in "My Hero Academia"?', 'Izuku Midoriya', 'Katsuki Bakugo', 'Shoto Todoroki', 'Toshinori Yagi', 'anime'],
  ['Which Pokémon travels on Ash\'s shoulder?', 'Pikachu', 'Charmander', 'Squirtle', 'Bulbasaur', 'anime'],
  // Cricket & sports
  ['How many balls are there in a standard cricket over?', '6', '5', '8', '10', 'sports'],
  ['Which Indian captain is known as "Captain Cool"?', 'MS Dhoni', 'Virat Kohli', 'Sourav Ganguly', 'Rohit Sharma', 'sports'],
  ['How many international centuries did Sachin Tendulkar score?', '100', '99', '101', '90', 'sports'],
  ['India beat which team in the 2024 T20 World Cup final?', 'South Africa', 'Australia', 'England', 'Pakistan', 'sports'],
  ['Who hit the winning six in the 2011 World Cup final?', 'MS Dhoni', 'Yuvraj Singh', 'Gautam Gambhir', 'Virat Kohli', 'sports'],
  ['Neeraj Chopra won Olympic gold at Tokyo 2020 in which event?', 'Javelin throw', 'Shot put', 'Long jump', 'Discus throw', 'sports'],
  ['Which Indian batter scored 264 in an ODI?', 'Rohit Sharma', 'Virender Sehwag', 'Sachin Tendulkar', 'Shubman Gill', 'sports'],
  ['How many players does a football team have on the field?', '11', '10', '9', '12', 'sports'],
  ['In cricket, what is a Super Over used for?', 'Breaking a tie', 'Making up for rain delays', 'Deciding the toss', 'Giving a bowler a bonus over', 'sports'],
  ['What is Virat Kohli\'s famous jersey number?', '18', '7', '45', '10', 'sports'],
  ['A bowler\'s hat-trick means taking…', '3 wickets in 3 balls in a row', '3 wickets in one over', '3 catches in a match', '3 wickets in a spell', 'sports'],
  ['In which year did the IPL start?', '2008', '2007', '2010', '2005', 'sports'],
  ['Who captained India to the 2007 T20 World Cup win?', 'MS Dhoni', 'Rahul Dravid', 'Sourav Ganguly', 'Anil Kumble', 'sports'],
  ['What is a "yorker" in cricket?', 'A ball aimed at the batter\'s feet', 'A very short bouncing ball', 'A slow spinning ball', 'A ball bowled from behind the stumps', 'sports'],
  ['Which country won the 2022 FIFA World Cup?', 'Argentina', 'France', 'Brazil', 'Spain', 'sports'],
  ['"Dangal" is based on the life of which wrestler and his daughters?', 'Mahavir Singh Phogat', 'Sushil Kumar', 'Yogeshwar Dutt', 'Bajrang Punia', 'sports'],
  ['Which film shows India\'s 1983 Cricket World Cup win?', '83', 'Lagaan', 'Iqbal', 'Jersey', 'sports'],
  ['Who played MS Dhoni in "M.S. Dhoni: The Untold Story"?', 'Sushant Singh Rajput', 'Ranveer Singh', 'Rajkummar Rao', 'Ayushmann Khurrana', 'sports'],
  ['"Chak De! India" is about which sport?', 'Hockey', 'Cricket', 'Football', 'Kabaddi', 'sports'],
  ['"Bhaag Milkha Bhaag" is about which athlete?', 'Milkha Singh', 'Paan Singh Tomar', 'P. T. Usha', 'Neeraj Chopra', 'sports'],
  ['In "Lagaan", the villagers play the British at which sport?', 'Cricket', 'Hockey', 'Football', 'Kabaddi', 'sports'],
  ['"Paan Singh Tomar" was a champion in which running event?', 'Steeplechase', 'Marathon', '100 metres', 'Relay', 'sports'],
];

const EMOJI = [
  ['3️⃣🤪🎓', '3 Idiots', 'bollywood'], ['🚂🌻💃', 'Dilwale Dulhania Le Jayenge', 'bollywood'], ['🔥🌊🤝', 'RRR', 'bollywood'],
  ['🗡️🏰👑', 'Baahubali', 'bollywood'], ['🌳🪓🕶️', 'Pushpa', 'bollywood'], ['⛏️💰👑', 'KGF', 'bollywood'],
  ['🎤🏙️🧢', 'Gully Boy', 'bollywood'], ['👻👩🏘️', 'Stree', 'bollywood'], ['👮‍♂️🦁🔥', 'Singham', 'bollywood'],
  ['🚀🔴👩‍🔬', 'Mission Mangal', 'bollywood'], ['🎺💍💃', 'Band Baaja Baaraat', 'bollywood'], ['🕶️🎹🔫', 'Andhadhun', 'bollywood'],
  ['👨‍🏫💰🏦', 'Money Heist', 'series'], ['🦑🎮💸', 'Squid Game', 'series'], ['🔫👑🧶', 'Mirzapur', 'series'],
  ['🏡🌾📝', 'Panchayat', 'series'], ['📈💼🐂', 'Scam 1992', 'series'], ['🕵️‍♂️👨‍👩‍👧‍👦🔫', 'The Family Man', 'series'],
  ['📚🏫🎯', 'Kota Factory', 'series'], ['🔦🚲👾', 'Stranger Things', 'series'], ['👨‍🔬💎🧪', 'Breaking Bad', 'series'],
  ['🐉👑⚔️', 'Game of Thrones', 'series'], ['☕🛋️👫', 'Friends', 'series'], ['👑🇬🇧👸', 'The Crown', 'series'],
  ['🖤✋🏫', 'Wednesday', 'series'], ['🧢🔪🥃', 'Peaky Blinders', 'series'],
  ['🦁👑', 'The Lion King', 'hollywood'], ['❄️👸⛄', 'Frozen', 'hollywood'], ['🚢🧊💔', 'Titanic', 'hollywood'],
  ['🧙‍♂️⚡👓', 'Harry Potter', 'hollywood'], ['🦖🏝️🚙', 'Jurassic Park', 'hollywood'], ['🚀🌽🕳️', 'Interstellar', 'hollywood'],
  ['🤖🌱❤️', 'WALL-E', 'hollywood'], ['🦇🌃🃏', 'The Dark Knight', 'hollywood'], ['🔴💊🕶️', 'The Matrix', 'hollywood'],
  ['🐠🔍🌊', 'Finding Nemo', 'hollywood'], ['🧸🤠🚀', 'Toy Story', 'hollywood'], ['🎈🏠👴', 'Up', 'hollywood'],
  ['💥☢️👨‍🔬', 'Oppenheimer', 'hollywood'], ['💖👱‍♀️🏖️', 'Barbie', 'hollywood'], ['🕷️🧑‍🎓🏙️', 'Spider-Man', 'hollywood'],
  ['🔨⚡👑', 'Thor', 'hollywood'], ['👽🚲🌕', 'E.T.', 'hollywood'], ['🦈🌊🏖️', 'Jaws', 'hollywood'],
  ['🍥🦊🥷', 'Naruto', 'anime'], ['🏴‍☠️👒🍖', 'One Piece', 'anime'], ['🗡️👹🌸', 'Demon Slayer', 'anime'],
  ['📓💀🍎', 'Death Note', 'anime'], ['⚡🐭🧢', 'Pokémon', 'anime'], ['🐉🟠⭐', 'Dragon Ball', 'anime'],
  ['🧱👹⚔️', 'Attack on Titan', 'anime'], ['🐱🤖🚪', 'Doraemon', 'anime'],
  ['🤼‍♀️👨‍👧‍👧🥇', 'Dangal', 'sports'], ['🏏🇬🇧🌧️', 'Lagaan', 'sports'], ['🏑🇮🇳👩', 'Chak De! India', 'sports'],
  ['🏃‍♂️🇮🇳🏅', 'Bhaag Milkha Bhaag', 'sports'], ['🏏🧢🚁', 'M.S. Dhoni: The Untold Story', 'sports'], ['8️⃣3️⃣🏏🏆', '83', 'sports'],
  ['🥊👩🇮🇳', 'Mary Kom', 'sports'], ['🏸👩🏆', 'Saina', 'sports'],
];

/** Three wrong titles for an emoji clue, from the same category (random). */
function emojiOptions(title, category, rand) {
  const r = rand || Math.random;
  const pool = EMOJI.filter((e) => e[2] === category && e[1] !== title).map((e) => e[1]);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return pool.slice(0, 3);
}

/** Rows in the same shape as the quiz_questions table. */
function starterRows(kind, rand) {
  if (kind === 'EMOJI') return EMOJI.map((e) => { const w = emojiOptions(e[1], e[2], rand); return { kind: 'EMOJI', question: e[0], options: [e[1]].concat(w), answer: 0, category: e[2], source: 'Starter pack' }; });
  return QUIZ.map((q) => ({ kind: 'QUIZ', question: q[0], options: q.slice(1, 5), answer: 0, category: q[5], source: 'Starter pack' }));
}

module.exports = { QUIZ, EMOJI, emojiOptions, starterRows };
