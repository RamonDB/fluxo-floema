window.GALLERY = {
  name: "Fluxo Floema",
  artist: "Vicente Baltar",
  artistDates: "n. 1952",
  email: "contato@galerialumen.com.br",
  rates: { BRL: 1, USD: 0.19, EUR: 0.17 },
  // Repositório onde as obras são publicadas. As obras ficam em data/artworks.json
  // e as fotos em images/obras/. O login usa um token do GitHub com permissão
  // "Contents: Read and write" neste repositório.
  github: {
    owner: "RamonDB",
    repo: "fluxo-floema",
    branch: "main"
  }
};
