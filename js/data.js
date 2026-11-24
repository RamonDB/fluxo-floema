window.GALLERY = {
  name: "Fluxo Floema",
  artist: "Vicente Baltar",
  artistDates: "n. 1952",
  email: "contato@galerialumen.com.br",
  rates: { BRL: 1, USD: 0.19, EUR: 0.17 },
  // Login: usuário + senha (conferidos pelo hash abaixo). O token do GitHub é pedido só na
  // primeira vez em cada navegador e fica salvo nele criptografado com a senha.
  // passwordHash = SHA-256 de `${salt}:${senha}`. Para trocar a senha, gere um novo par com:
  // node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s,c.createHash('sha256').update(s+':'+'NOVA_SENHA').digest('hex'))"
  admin: {
    user: "admin",
    salt: "b75a3bdc8d0b65f8bd7d3f15fd27cfc5",
    passwordHash: "f46f0c0d172d5eb03a732b1df3ed467876ab37ee885aa57f88b30ba16a011083"
  },
  // Repositório onde as obras são publicadas. As obras ficam em data/artworks.json
  // e as fotos em images/obras/. O login usa um token do GitHub com permissão
  // "Contents: Read and write" neste repositório.
  github: {
    owner: "RamonDB",
    repo: "fluxo-floema",
    branch: "main",
    // Em hospedagem fora do GitHub (ex.: GoDaddy), os visitantes leem obras, textos e fotos
    // direto do repositório, então as publicações feitas pelo site aparecem sem novo upload.
    // Use false para ler apenas os arquivos hospedados junto com o site.
    readFromGitHub: true
  }
};
