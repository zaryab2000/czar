// The bundled corpus behind the lab's extract services (CZ-20 §5.8a "Data", PM-041 ruling, 2026-11-05).
//
// Twenty short excerpts, every one published before 1929 and therefore in the public domain in the United
// States on the date alone. Each is a few sentences, never a whole work. `SOURCES.md` beside this file records
// every text's title, author, year and public-domain basis; a test keeps the two in step.
//
// Nothing here is fetched. `url` is the identifier a buyer sends to `lab-extract-*` and the public page the
// excerpt was taken from; the lab never requests it. The text is data: it is returned as-is, labelled
// `untrusted`, and never acted on.

export interface LabPage {
  /** Stable short id, also the key in `SOURCES.md`. */
  readonly id: string;
  /** The identifier a buyer sends; it names the public page the excerpt came from. */
  readonly url: string;
  readonly title: string;
  readonly author: string;
  /** Year of first publication; always before 1929. */
  readonly year: number;
  /** Why the text is in the public domain. */
  readonly basis: string;
  /** The excerpt. */
  readonly text: string;
}

const PRE_1929 = (year: number) =>
  `First published in ${year}, before 1929, so it is in the US public domain on its date.`;

export const LAB_CORPUS: readonly LabPage[] = [
  {
    id: "austen-pride-and-prejudice",
    url: "https://www.gutenberg.org/ebooks/1342",
    title: "Pride and Prejudice",
    author: "Jane Austen",
    year: 1813,
    basis: PRE_1929(1813),
    text: "It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.\n\nHowever little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.",
  },
  {
    id: "carroll-alice",
    url: "https://www.gutenberg.org/ebooks/11",
    title: "Alice's Adventures in Wonderland",
    author: "Lewis Carroll",
    year: 1865,
    basis: PRE_1929(1865),
    text: 'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do: once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it, "and what is the use of a book," thought Alice "without pictures or conversations?"',
  },
  {
    id: "melville-moby-dick",
    url: "https://www.gutenberg.org/ebooks/2701",
    title: "Moby-Dick; or, The Whale",
    author: "Herman Melville",
    year: 1851,
    basis: PRE_1929(1851),
    text: "Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation.",
  },
  {
    id: "shelley-frankenstein",
    url: "https://www.gutenberg.org/ebooks/84",
    title: "Frankenstein; or, The Modern Prometheus",
    author: "Mary Wollstonecraft Shelley",
    year: 1818,
    basis: PRE_1929(1818),
    text: "You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings. I arrived here yesterday, and my first task is to assure my dear sister of my welfare and increasing confidence in the success of my undertaking.",
  },
  {
    id: "dickens-tale-of-two-cities",
    url: "https://www.gutenberg.org/ebooks/98",
    title: "A Tale of Two Cities",
    author: "Charles Dickens",
    year: 1859,
    basis: PRE_1929(1859),
    text: "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was the season of Light, it was the season of Darkness, it was the spring of hope, it was the winter of despair, we had everything before us, we had nothing before us, we were all going direct to Heaven, we were all going direct the other way.",
  },
  {
    id: "doyle-sherlock-holmes",
    url: "https://www.gutenberg.org/ebooks/1661",
    title: "The Adventures of Sherlock Holmes (A Scandal in Bohemia)",
    author: "Arthur Conan Doyle",
    year: 1892,
    basis: PRE_1929(1892),
    text: "To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name. In his eyes she eclipses and predominates the whole of her sex.",
  },
  {
    id: "thoreau-walden",
    url: "https://www.gutenberg.org/ebooks/205",
    title: "Walden; or, Life in the Woods",
    author: "Henry David Thoreau",
    year: 1854,
    basis: PRE_1929(1854),
    text: "I went to the woods because I wished to live deliberately, to front only the essential facts of life, and see if I could not learn what it had to teach, and not, when I came to die, discover that I had not lived.",
  },
  {
    id: "darwin-origin-of-species",
    url: "https://www.gutenberg.org/ebooks/1228",
    title: "On the Origin of Species",
    author: "Charles Darwin",
    year: 1859,
    basis: PRE_1929(1859),
    text: "There is grandeur in this view of life, with its several powers, having been originally breathed into a few forms or into one; and that, whilst this planet has gone cycling on according to the fixed law of gravity, from so simple a beginning endless forms most beautiful and most wonderful have been, and are being, evolved.",
  },
  {
    id: "sun-tzu-art-of-war",
    url: "https://www.gutenberg.org/ebooks/132",
    title: "The Art of War",
    author: "Sun Tzu, translated by Lionel Giles",
    year: 1910,
    basis: `${PRE_1929(1910)} The translation (Lionel Giles, 1910) and the original (c. 5th century BC) are both in the public domain.`,
    text: "Sun Tzu said: The art of war is of vital importance to the State. It is a matter of life and death, a road either to safety or to ruin. Hence it is a subject of inquiry which can on no account be neglected.",
  },
  {
    id: "madison-federalist-10",
    url: "https://www.gutenberg.org/ebooks/1404",
    title: "The Federalist No. 10",
    author: "James Madison",
    year: 1787,
    basis: PRE_1929(1787),
    text: "Among the numerous advantages promised by a well-constructed Union, none deserves to be more accurately developed than its tendency to break and control the violence of faction.",
  },
  {
    id: "declaration-of-independence",
    url: "https://www.archives.gov/founding-docs/declaration-transcript",
    title: "The Declaration of Independence",
    author: "Thomas Jefferson and the Continental Congress",
    year: 1776,
    basis: `${PRE_1929(1776)} It is also a founding document of the United States government.`,
    text: "When in the Course of human events, it becomes necessary for one people to dissolve the political bands which have connected them with another, and to assume among the powers of the earth, the separate and equal station to which the Laws of Nature and of Nature's God entitle them, a decent respect to the opinions of mankind requires that they should declare the causes which impel them to the separation.",
  },
  {
    id: "us-constitution-preamble",
    url: "https://www.archives.gov/founding-docs/constitution-transcript",
    title: "The Constitution of the United States (Preamble)",
    author: "The Constitutional Convention",
    year: 1787,
    basis: `${PRE_1929(1787)} It is also a founding document of the United States government.`,
    text: "We the People of the United States, in Order to form a more perfect Union, establish Justice, insure domestic Tranquility, provide for the common defence, promote the general Welfare, and secure the Blessings of Liberty to ourselves and our Posterity, do ordain and establish this Constitution for the United States of America.",
  },
  {
    id: "lincoln-gettysburg-address",
    url: "https://www.loc.gov/exhibits/gettysburg-address/",
    title: "The Gettysburg Address",
    author: "Abraham Lincoln",
    year: 1863,
    basis: `${PRE_1929(1863)} It was also written by the President in his official capacity.`,
    text: "Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.\n\nNow we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure.",
  },
  {
    id: "lincoln-emancipation-proclamation",
    url: "https://www.archives.gov/exhibits/featured-documents/emancipation-proclamation/transcript.html",
    title: "The Emancipation Proclamation",
    author: "Abraham Lincoln",
    year: 1863,
    basis: `${PRE_1929(1863)} It was also issued by the President in his official capacity.`,
    text: "That on the first day of January, in the year of our Lord one thousand eight hundred and sixty-three, all persons held as slaves within any State or designated part of a State, the people whereof shall then be in rebellion against the United States, shall be then, thenceforward, and forever free; and the Executive Government of the United States, including the military and naval authority thereof, will recognize and maintain the freedom of said persons.",
  },
  {
    id: "lincoln-second-inaugural",
    url: "https://avalon.law.yale.edu/19th_century/lincoln2.asp",
    title: "Second Inaugural Address",
    author: "Abraham Lincoln",
    year: 1865,
    basis: `${PRE_1929(1865)} It was also delivered by the President in his official capacity.`,
    text: "With malice toward none, with charity for all, with firmness in the right as God gives us to see the right, let us strive on to finish the work we are in, to bind up the nation's wounds, to care for him who shall have borne the battle and for his widow and his orphan, to do all which may achieve and cherish a just and lasting peace among ourselves and with all nations.",
  },
  {
    id: "washington-farewell-address",
    url: "https://avalon.law.yale.edu/18th_century/washing.asp",
    title: "Washington's Farewell Address",
    author: "George Washington",
    year: 1796,
    basis: `${PRE_1929(1796)} It was also written by the President in his official capacity.`,
    text: "The Unity of Government which constitutes you one people is also now dear to you. It is justly so; for it is a main Pillar in the Edifice of your real independence, the support of your tranquility at home; your peace abroad; of your safety; of your prosperity; of that very Liberty, which you so highly prize.",
  },
  {
    id: "monroe-doctrine",
    url: "https://avalon.law.yale.edu/19th_century/monroe.asp",
    title: "The Monroe Doctrine (Seventh Annual Message to Congress)",
    author: "James Monroe",
    year: 1823,
    basis: `${PRE_1929(1823)} It was also written by the President in his official capacity.`,
    text: "The occasion has been judged proper for asserting, as a principle in which the rights and interests of the United States are involved, that the American continents, by the free and independent condition which they have assumed and maintain, are henceforth not to be considered as subjects for future colonization by any European powers.",
  },
  {
    id: "dickens-great-expectations",
    url: "https://www.gutenberg.org/ebooks/1400",
    title: "Great Expectations",
    author: "Charles Dickens",
    year: 1861,
    basis: PRE_1929(1861),
    text: "My father's family name being Pirrip, and my Christian name Philip, my infant tongue could make of both names nothing longer or more explicit than Pip. So, I called myself Pip, and came to be called Pip.",
  },
  {
    id: "twain-huckleberry-finn",
    url: "https://www.gutenberg.org/ebooks/76",
    title: "Adventures of Huckleberry Finn",
    author: "Mark Twain",
    year: 1885,
    basis: `${PRE_1929(1885)} (First US edition; the first UK edition appeared in 1884.)`,
    text: "You don't know about me without you have read a book by the name of The Adventures of Tom Sawyer; but that ain't no matter. That book was made by Mr. Mark Twain, and he told the truth, mainly. There was things which he stretched, but mainly he told the truth.",
  },
  {
    id: "stevenson-treasure-island",
    url: "https://www.gutenberg.org/ebooks/120",
    title: "Treasure Island",
    author: "Robert Louis Stevenson",
    year: 1883,
    basis: PRE_1929(1883),
    text: "Squire Trelawney, Dr. Livesey, and the rest of these gentlemen having asked me to write down the whole particulars about Treasure Island, from the beginning to the end, keeping nothing back but the bearings of the island, and that only because there is still treasure not yet lifted, I take up my pen in the year of grace 17—, and go back to the time when my father kept the Admiral Benbow inn and the brown old seaman with the sabre cut first took up his lodging under our roof.",
  },
];

/** The page a buyer's `url` names, or `undefined` when the lab does not serve it. */
export function labPageByUrl(url: string): LabPage | undefined {
  return LAB_CORPUS.find((page) => page.url === url);
}
